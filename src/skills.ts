import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  captureTreeSnapshot,
  computeEquivalenceRecord,
  fsyncDir,
  snapshotsEqual,
  stableJson,
  type EquivalenceRecordResult,
} from "./paths.ts";
import { clearJournal, writeJournal } from "./state.ts";
import type {
  ApplyHooks,
  OwnershipStateV2,
  PendingJournalRecord,
  PlannedOp,
  TargetSnapshot,
} from "./types.ts";

export type PlannedSkillInstall = {
  op: PlannedOp;
  name: string;
  srcDir: string;
  dstDir: string;
  isReplace: boolean;
  beforeSnapshot: TargetSnapshot;
};

export type StagedSkillPlan = {
  installs: PlannedSkillInstall[];
  plannedSkillNames: string[];
  /** Maps planned skill name -> staged source directory for single-pass --adopt --skill. */
  plannedSkillSources: Map<string, string>;
  tempDirs: string[];
};

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_WRAPPER_DEPTH = 16;

/**
 * Parse a single YAML scalar value for `name:` in SKILL.md frontmatter:
 * - Supports double-quoted ("foo" # comment) and single-quoted ('foo' # comment) scalars
 * - Strips inline YAML comments (`# ...` preceded by whitespace) on unquoted scalars
 */
export function parseYamlScalar(raw: string): string {
  const s = raw.trim();
  if (s.length === 0) return "";

  if (s[0] === '"') {
    let out = "";
    let escaped = false;
    for (let i = 1; i < s.length; i += 1) {
      const ch = s[i]!;
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') return out.trim();
      out += ch;
    }
    return out.trim();
  }

  if (s[0] === "'") {
    let out = "";
    for (let i = 1; i < s.length; i += 1) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        return out.trim();
      }
      out += s[i]!;
    }
    return out.trim();
  }

  // Unquoted scalar: strip `#` comment when preceded by whitespace (or at index 0).
  const commentMatch = s.match(/(?:^|\s)#/);
  const withoutComment = commentMatch ? s.slice(0, commentMatch.index) : s;
  return withoutComment.trim();
}

export function extractSkillName(skillMdPath: string): string {
  const content = readFileSync(skillMdPath, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || !/^---\s*$/.test(lines[0]!)) return "";
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^---\s*$/.test(line)) break;
    const m = line.match(/^name:\s*(.*)$/);
    if (m) {
      return parseYamlScalar(m[1]!);
    }
  }
  return "";
}

function isGitUrl(source: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@[^:]+:)/.test(source);
}

function runTool(cmd: string[], errorPrefix: string): void {
  const res = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    const stderr = res.stderr.toString("utf8").trim();
    throw new Error(`${errorPrefix}: ${stderr || `exit ${res.exitCode}`}`);
  }
}

/**
 * Verify a staged/extracted skill tree contains no absolute symlinks, no escaping
 * relative symlinks (e.g. `../../../../.ssh/id_rsa`), no cyclic symlinks, and no
 * special filesystem objects (FIFOs, sockets, devices) before copying into <hub>/skills/.
 */
export function validateSkillTreeSafety(treeRoot: string, excludeRootGit = true): void {
  const absRoot = resolve(treeRoot);
  const visitedDirs = new Set<string>();

  const walk = (absDir: string, relDir: string): void => {
    const dirSt = lstatSync(absDir);
    if (!dirSt.isDirectory()) {
      throw new Error(`sync-agents: unsafe non-directory skill root: ${absDir}`);
    }
    const dirKey = `${dirSt.dev}:${dirSt.ino}`;
    if (visitedDirs.has(dirKey)) {
      throw new Error(`sync-agents: cyclic directory detected in skill source at "${relDir || "."}"`);
    }
    visitedDirs.add(dirKey);

    for (const entry of readdirSync(absDir).sort()) {
      if (excludeRootGit && relDir === "" && entry === ".git") continue;
      const childAbs = join(absDir, entry);
      const childRel = relDir ? `${relDir}/${entry}` : entry;
      const st = lstatSync(childAbs);

      if (st.isSymbolicLink()) {
        const target = readlinkSync(childAbs);
        if (isAbsolute(target)) {
          throw new Error(
            `sync-agents: skill source contains unsafe absolute symlink "${childRel}" -> "${target}"`,
          );
        }
        const resolvedTarget = resolve(dirname(childAbs), target);
        const relToRoot = relative(absRoot, resolvedTarget);
        if (relToRoot === ".." || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
          throw new Error(
            `sync-agents: skill source contains escaping relative symlink "${childRel}" -> "${target}"`,
          );
        }
        // Reject self/ancestor cyclic symlinks (e.g. `a -> .` or `sub/a -> ..`).
        if (
          resolvedTarget === absDir ||
          resolvedTarget === absRoot ||
          absDir.startsWith(`${resolvedTarget}${sep}`)
        ) {
          throw new Error(
            `sync-agents: skill source contains cyclic symlink "${childRel}" -> "${target}"`,
          );
        }
        continue;
      }

      if (st.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }

      if (!st.isFile()) {
        throw new Error(
          `sync-agents: skill source contains unsupported special file at "${childRel}"`,
        );
      }
    }
  };

  walk(absRoot, "");
}

function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function isRealDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function discoverSkillDirsInTree(
  treeRoot: string,
  fallbackName: string,
  visited = new Set<string>(),
  depth = 0,
): Array<{ srcDir: string; fallbackName: string }> {
  if (depth > MAX_WRAPPER_DEPTH) {
    throw new Error(`sync-agents: skill archive wrapper nesting exceeded ${MAX_WRAPPER_DEPTH} levels in ${treeRoot}`);
  }

  const rootStat = lstatSync(treeRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`sync-agents: refusing symlink or non-directory skill root: ${treeRoot}`);
  }
  const key = `${rootStat.dev}:${rootStat.ino}`;
  if (visited.has(key)) {
    throw new Error(`sync-agents: cyclic directory structure detected in ${treeRoot}`);
  }
  visited.add(key);

  if (isRegularFile(join(treeRoot, "SKILL.md"))) {
    return [{ srcDir: treeRoot, fallbackName }];
  }

  const skillsSub = join(treeRoot, "skills");
  if (isRealDirectory(skillsSub)) {
    const found: Array<{ srcDir: string; fallbackName: string }> = [];
    for (const entry of readdirSync(skillsSub).sort()) {
      const full = join(skillsSub, entry);
      if (isRealDirectory(full) && isRegularFile(join(full, "SKILL.md"))) {
        found.push({ srcDir: full, fallbackName: entry });
      }
    }
    if (found.length > 0) return found;
  }

  // Single top-level wrapper directory (strictly non-symlink real directory only!)
  const children = readdirSync(treeRoot)
    .filter((name) => name !== "__MACOSX")
    .sort()
    .map((name) => join(treeRoot, name));
  if (children.length === 1) {
    const onlyChild = children[0]!;
    const childStat = lstatSync(onlyChild);
    if (childStat.isSymbolicLink()) {
      throw new Error(
        `sync-agents: refusing to traverse top-level symlink "${basename(onlyChild)}" in skill source ${treeRoot}`,
      );
    }
    if (childStat.isDirectory()) {
      return discoverSkillDirsInTree(onlyChild, basename(onlyChild), visited, depth + 1);
    }
  }

  throw new Error(`sync-agents: no SKILL.md found in ${treeRoot}`);
}

function stageSingleSource(
  sourcePath: string,
  cwd: string,
  tempDirs: string[],
): Array<{ srcDir: string; fallbackName: string }> {
  if (isGitUrl(sourcePath)) {
    const trimmed = sourcePath.replace(/\/+$/, "");
    const base = basename(trimmed);
    const fallback = base.endsWith(".git") ? base.slice(0, -4) : base;
    const unpackDir = mkdtempSync(join(tmpdir(), "sync-agents-skill-"));
    tempDirs.push(unpackDir);
    const repoDir = join(unpackDir, "repo");
    runTool(
      ["git", "clone", "--depth", "1", "--quiet", "--", sourcePath, repoDir],
      `git clone ${sourcePath}`,
    );
    rmSync(join(repoDir, ".git"), { recursive: true, force: true });
    return discoverSkillDirsInTree(repoDir, fallback);
  }

  // Resolve local paths to absolute paths so filenames starting with '-' can NEVER be
  // interpreted as CLI flags by git, unzip, or tar.
  const absSource = resolve(cwd, sourcePath);
  if (!existsSync(absSource)) {
    throw new Error(`sync-agents: skill source not found: ${sourcePath}`);
  }

  if (statSync(absSource).isDirectory()) {
    return discoverSkillDirsInTree(absSource, basename(absSource));
  }

  const base = basename(absSource);
  const fallback = base.split(".")[0] || base;
  const unpackDir = mkdtempSync(join(tmpdir(), "sync-agents-skill-"));
  tempDirs.push(unpackDir);

  // Detect git bundle first (even without .bundle suffix); absSource always starts with '/'.
  const bundleCheck = Bun.spawnSync(["git", "bundle", "list-heads", absSource], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (bundleCheck.exitCode === 0) {
    const repoDir = join(unpackDir, "repo");
    runTool(
      ["git", "clone", "--quiet", "--", absSource, repoDir],
      `git clone bundle ${sourcePath}`,
    );
    rmSync(join(repoDir, ".git"), { recursive: true, force: true });
    return discoverSkillDirsInTree(repoDir, fallback);
  }

  if (absSource.endsWith(".zip") || absSource.endsWith(".skill")) {
    runTool(["unzip", "-q", absSource, "-d", unpackDir], `unzip ${sourcePath}`);
    return discoverSkillDirsInTree(unpackDir, fallback);
  }

  if (/\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(absSource)) {
    runTool(["tar", "-xf", absSource, "-C", unpackDir], `tar extract ${sourcePath}`);
    return discoverSkillDirsInTree(unpackDir, fallback);
  }

  throw new Error(
    `sync-agents: unsupported skill format: ${sourcePath} (expected directory, git repo URL, git .bundle, .zip/.skill, or tarball)`,
  );
}

function copyTreeWithoutRootGit(srcDir: string, dstDir: string): void {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir).sort()) {
    if (entry === ".git") continue;
    cpSync(join(srcDir, entry), join(dstDir, entry), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: false,
    });
  }
  chmodSync(dstDir, 0o755);
}

function skillRecordsMatch(
  srcRec: EquivalenceRecordResult,
  dstRec: EquivalenceRecordResult,
): boolean {
  if (!srcRec.ok || !dstRec.ok) return false;
  if (srcRec.entries.length !== dstRec.entries.length) return false;
  for (let i = 0; i < srcRec.entries.length; i += 1) {
    const s = srcRec.entries[i]!;
    const d = dstRec.entries[i]!;
    if (s.relPath !== d.relPath || s.kind !== d.kind) return false;
    if (s.kind === "file" && s.sha256 !== d.sha256) return false;
    if (s.kind === "symlink" && s.symlinkTarget !== d.symlinkTarget) return false;
    if (s.relPath !== "" && s.mode !== d.mode) return false;
    if (s.relPath !== "" && stableJson(s.xattrs) !== stableJson(d.xattrs)) return false;
  }
  return true;
}

export function planSkillInstalls(
  skillSources: string[],
  canonicalHubPath: string,
  opts: { force: boolean; forceSkill: boolean; cwd?: string },
): StagedSkillPlan {
  const tempDirs: string[] = [];
  const installs: PlannedSkillInstall[] = [];
  const plannedSkillNames: string[] = [];
  const plannedSkillSources = new Map<string, string>();
  const canonicalSkillsRoot = join(canonicalHubPath, "skills");
  const cwd = opts.cwd ?? process.cwd();

  try {
    for (const source of skillSources) {
      const discovered = stageSingleSource(source, cwd, tempDirs);
      for (const { srcDir, fallbackName } of discovered) {
        // Security check: reject escaping/absolute/cyclic symlinks and special files upfront.
        validateSkillTreeSafety(srcDir, true);

        const skillMd = join(srcDir, "SKILL.md");
        if (!isRegularFile(skillMd)) {
          throw new Error(`sync-agents: missing SKILL.md in ${srcDir}`);
        }
        const extracted = extractSkillName(skillMd);
        const name = extracted || fallbackName;
        if (!SKILL_NAME_RE.test(name)) {
          throw new Error(`sync-agents: invalid skill name "${name}" from ${srcDir}`);
        }

        const dstDir = join(canonicalSkillsRoot, name);
        if (!plannedSkillNames.includes(name)) plannedSkillNames.push(name);
        plannedSkillSources.set(name, srcDir);

        let dstStat = null;
        try {
          dstStat = lstatSync(dstDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
        }

        if (dstStat && dstStat.isDirectory()) {
          // Compute destination equivalence record ONCE and reuse for both match check and snapshot!
          const srcRec = computeEquivalenceRecord(srcDir, { excludeRootGit: true });
          const dstRec = computeEquivalenceRecord(dstDir, { excludeRootGit: false });
          if (!dstRec.ok) {
            throw new Error(`cannot snapshot existing skill ${dstDir}: ${dstRec.reason}`);
          }
          const beforeSnap: TargetSnapshot = {
            kind: "tree",
            rootKind: dstRec.rootKind,
            equivalenceDigest: dstRec.digest,
          };

          if (skillRecordsMatch(srcRec, dstRec)) {
            installs.push({
              name,
              srcDir,
              dstDir,
              isReplace: false,
              beforeSnapshot: beforeSnap,
              op: {
                domain: "skill",
                action: "keep",
                status: "ok",
                destination: dstDir,
                observed: "canonical skill directory matches source",
                intended: `skill "${name}" from ${srcDir}`,
                ownershipBasis: "canonical-hub",
                reason: "already up to date",
                targetMutation: false,
                ledgerMutation: false,
              },
            });
            continue;
          }

          if (!opts.forceSkill && !opts.force) {
            installs.push({
              name,
              srcDir,
              dstDir,
              isReplace: true,
              beforeSnapshot: beforeSnap,
              op: {
                domain: "skill",
                action: "conflict",
                status: "conflict",
                destination: dstDir,
                observed: "existing canonical skill directory differs from source",
                intended: `replace skill "${name}" from ${srcDir}`,
                ownershipBasis: "canonical-hub-unconsented",
                reason: `skill "${name}" already exists at ${dstDir} and differs`,
                nextStep: "Inspect changes, or re-run with --force-skill to replace only the skill",
                targetMutation: false,
                ledgerMutation: false,
              },
            });
            continue;
          }

          installs.push({
            name,
            srcDir,
            dstDir,
            isReplace: true,
            beforeSnapshot: beforeSnap,
            op: {
              domain: "skill",
              action: "skill-replace",
              status: "change",
              destination: dstDir,
              observed: "existing canonical skill directory differs from source",
              intended: `replace skill "${name}" -> ${dstDir}`,
              ownershipBasis: opts.forceSkill ? "forced-skill" : "forced",
              reason: opts.forceSkill
                ? "explicit --force-skill authorized replacing canonical skill"
                : "explicit --force authorized replacing canonical skill",
              targetMutation: true,
              ledgerMutation: false,
            },
          });
          continue;
        }

        if (dstStat) {
          installs.push({
            name,
            srcDir,
            dstDir,
            isReplace: false,
            beforeSnapshot: { kind: "absent" },
            op: {
              domain: "skill",
              action: "conflict",
              status: "conflict",
              destination: dstDir,
              observed: "non-directory exists at canonical skill path",
              intended: `install skill "${name}" -> ${dstDir}`,
              ownershipBasis: "unmanaged",
              reason: `${dstDir} exists and is not a directory`,
              nextStep: `Move or remove ${dstDir} manually before installing skill "${name}"`,
              targetMutation: false,
              ledgerMutation: false,
            },
          });
          continue;
        }

        installs.push({
          name,
          srcDir,
          dstDir,
          isReplace: false,
          beforeSnapshot: { kind: "absent" },
          op: {
            domain: "skill",
            action: "skill-install",
            status: "change",
            destination: dstDir,
            observed: "absent",
            intended: `install skill "${name}" -> ${dstDir}`,
            ownershipBasis: "created",
            reason: "canonical skill does not exist yet",
            targetMutation: true,
            ledgerMutation: false,
          },
        });
      }
    }
  } catch (err) {
    cleanupStagedTempDirs(tempDirs);
    throw err;
  }

  return { installs, plannedSkillNames, plannedSkillSources, tempDirs };
}

export function applySkillInstall(
  item: PlannedSkillInstall,
  canonicalHubPath: string,
  state: OwnershipStateV2,
  journalPath: string,
  flags: { adopt: boolean; force: boolean; forceSkill: boolean },
  hooks?: ApplyHooks,
): void {
  if (item.op.status !== "change") return;

  const skillsRoot = join(canonicalHubPath, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const opId = `skill-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const stagedPath = join(skillsRoot, `.staging-${item.name}-${opId}`);

  // Track whether stagedPath has been handed off to a durable journal.
  // Before handoff, ANY error cleans up stagedPath so .staging-* is never leaked into <hub>/skills/.
  let journalOwnsStaged = false;

  try {
    copyTreeWithoutRootGit(item.srcDir, stagedPath);

    if (!item.isReplace) {
      if (existsSync(item.dstDir)) {
        throw new Error(
          `stale snapshot: ${item.dstDir} appeared after planning; refusing to overwrite`,
        );
      }
      renameSync(stagedPath, item.dstDir);
      fsyncDir(skillsRoot);
      return;
    }

    const backupPath = join(skillsRoot, `.backup-${item.name}-${opId}`);
    const afterSnapshot = captureTreeSnapshot(stagedPath);

    const journal: PendingJournalRecord = {
      version: 1,
      opId,
      hubPath: canonicalHubPath,
      expectedStateGeneration: state.generation,
      targetStateGeneration: state.generation,
      kind: "skill-replace",
      authorization: {
        flags,
        basis: "forced",
        reason: item.op.reason,
      },
      destination: item.dstDir,
      before: item.beforeSnapshot,
      after: afterSnapshot,
      backupPath,
      stagedPath,
      stateDelta: { kind: "none" },
    };

    writeJournal(journalPath, journal);
    journalOwnsStaged = true;
    hooks?.beforeTargetMutate?.(journal);

    const liveBefore = captureTreeSnapshot(item.dstDir);
    if (!snapshotsEqual(liveBefore, item.beforeSnapshot)) {
      rmSync(stagedPath, { recursive: true, force: true });
      clearJournal(journalPath);
      journalOwnsStaged = false;
      throw new Error(
        `stale snapshot: ${item.dstDir} changed after planning; preserving newer destination`,
      );
    }

    renameSync(item.dstDir, backupPath);
    fsyncDir(skillsRoot);
    hooks?.afterBackupRename?.(journal);

    renameSync(stagedPath, item.dstDir);
    fsyncDir(skillsRoot);
    hooks?.afterTargetMutate?.(journal);

    rmSync(backupPath, { recursive: true, force: true });
    fsyncDir(skillsRoot);
    clearJournal(journalPath);
  } catch (err) {
    if (!journalOwnsStaged && existsSync(stagedPath)) {
      try {
        rmSync(stagedPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
    throw err;
  }
}

export function cleanupStagedTempDirs(tempDirs: string[]): void {
  for (const dir of tempDirs) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
