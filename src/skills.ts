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
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  captureTreeSnapshot,
  computeEquivalenceRecord,
  fsyncDir,
  snapshotsEqual,
  stableJson,
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
  afterSnapshot?: TargetSnapshot;
};

export type StagedSkillPlan = {
  installs: PlannedSkillInstall[];
  plannedSkillNames: string[];
  tempDirs: string[];
};

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function extractSkillName(skillMdPath: string): string {
  const content = readFileSync(skillMdPath, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || !/^---\s*$/.test(lines[0]!)) return "";
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^---\s*$/.test(line)) break;
    const m = line.match(/^name:\s*(.*?)\s*$/);
    if (m) {
      return m[1]!.replace(/^["']|["']$/g, "");
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

function discoverSkillDirsInTree(
  treeRoot: string,
  fallbackName: string,
): Array<{ srcDir: string; fallbackName: string }> {
  if (existsSync(join(treeRoot, "SKILL.md")) && statSync(join(treeRoot, "SKILL.md")).isFile()) {
    return [{ srcDir: treeRoot, fallbackName }];
  }

  const skillsSub = join(treeRoot, "skills");
  if (existsSync(skillsSub) && statSync(skillsSub).isDirectory()) {
    const found: Array<{ srcDir: string; fallbackName: string }> = [];
    for (const entry of readdirSync(skillsSub).sort()) {
      const full = join(skillsSub, entry);
      if (
        existsSync(full) &&
        statSync(full).isDirectory() &&
        existsSync(join(full, "SKILL.md")) &&
        statSync(join(full, "SKILL.md")).isFile()
      ) {
        found.push({ srcDir: full, fallbackName: entry });
      }
    }
    if (found.length > 0) return found;
  }

  // Single top-level wrapper directory
  const children = readdirSync(treeRoot)
    .filter((name) => name !== "__MACOSX")
    .sort()
    .map((name) => join(treeRoot, name));
  if (children.length === 1 && statSync(children[0]!).isDirectory()) {
    return discoverSkillDirsInTree(children[0]!, basename(children[0]!));
  }

  throw new Error(`sync-agents: no SKILL.md found in ${treeRoot}`);
}

function stageSingleSource(
  sourcePath: string,
  tempDirs: string[],
): Array<{ srcDir: string; fallbackName: string }> {
  if (isGitUrl(sourcePath)) {
    const trimmed = sourcePath.replace(/\/+$/, "");
    const base = basename(trimmed);
    const fallback = base.endsWith(".git") ? base.slice(0, -4) : base;
    const unpackDir = mkdtempSync(join(tmpdir(), "sync-agents-skill-"));
    tempDirs.push(unpackDir);
    const repoDir = join(unpackDir, "repo");
    runTool(["git", "clone", "--depth", "1", "--quiet", sourcePath, repoDir], `git clone ${sourcePath}`);
    rmSync(join(repoDir, ".git"), { recursive: true, force: true });
    return discoverSkillDirsInTree(repoDir, fallback);
  }

  if (!existsSync(sourcePath)) {
    throw new Error(`sync-agents: skill source not found: ${sourcePath}`);
  }

  if (statSync(sourcePath).isDirectory()) {
    return discoverSkillDirsInTree(sourcePath, basename(sourcePath));
  }

  const base = basename(sourcePath);
  const fallback = base.split(".")[0] || base;
  const unpackDir = mkdtempSync(join(tmpdir(), "sync-agents-skill-"));
  tempDirs.push(unpackDir);

  // Detect git bundle first (even without .bundle suffix).
  const bundleCheck = Bun.spawnSync(["git", "bundle", "list-heads", sourcePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (bundleCheck.exitCode === 0) {
    const repoDir = join(unpackDir, "repo");
    runTool(["git", "clone", "--quiet", sourcePath, repoDir], `git clone bundle ${sourcePath}`);
    rmSync(join(repoDir, ".git"), { recursive: true, force: true });
    return discoverSkillDirsInTree(repoDir, fallback);
  }

  if (sourcePath.endsWith(".zip") || sourcePath.endsWith(".skill")) {
    runTool(["unzip", "-q", sourcePath, "-d", unpackDir], `unzip ${sourcePath}`);
    return discoverSkillDirsInTree(unpackDir, fallback);
  }

  if (/\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/.test(sourcePath)) {
    runTool(["tar", "-xf", sourcePath, "-C", unpackDir], `tar extract ${sourcePath}`);
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

/**
 * Compare candidate skill source (excluding root `.git`, which is stripped on install)
 * against existing canonical destination (full tree, NOT excluding `.git`).
 */
function skillTreesMatch(srcDir: string, dstDir: string): boolean {
  const srcRec = computeEquivalenceRecord(srcDir, { excludeRootGit: true });
  const dstRec = computeEquivalenceRecord(dstDir, { excludeRootGit: false });
  if (!srcRec.ok || !dstRec.ok) return false;
  if (srcRec.entries.length !== dstRec.entries.length) return false;
  for (let i = 0; i < srcRec.entries.length; i += 1) {
    const s = srcRec.entries[i]!;
    const d = dstRec.entries[i]!;
    if (s.relPath !== d.relPath || s.kind !== d.kind) return false;
    if (s.kind === "file" && s.sha256 !== d.sha256) return false;
    if (s.kind === "symlink" && s.symlinkTarget !== d.symlinkTarget) return false;
    // Check permission bits on non-root entries (root dir mode is normalized to 0755 on install).
    if (s.relPath !== "" && s.mode !== d.mode) return false;
    if (s.relPath !== "" && stableJson(s.xattrs) !== stableJson(d.xattrs)) return false;
  }
  return true;
}

export function planSkillInstalls(
  skillSources: string[],
  canonicalHubPath: string,
  opts: { force: boolean; forceSkill: boolean },
): StagedSkillPlan {
  const tempDirs: string[] = [];
  const installs: PlannedSkillInstall[] = [];
  const plannedSkillNames: string[] = [];
  const canonicalSkillsRoot = join(canonicalHubPath, "skills");

  try {
    for (const source of skillSources) {
      const discovered = stageSingleSource(source, tempDirs);
      for (const { srcDir, fallbackName } of discovered) {
        const skillMd = join(srcDir, "SKILL.md");
        if (!existsSync(skillMd) || !statSync(skillMd).isFile()) {
          throw new Error(`sync-agents: missing SKILL.md in ${srcDir}`);
        }
        const extracted = extractSkillName(skillMd);
        const name = extracted || fallbackName;
        if (!SKILL_NAME_RE.test(name)) {
          throw new Error(`sync-agents: invalid skill name "${name}" from ${srcDir}`);
        }

        const dstDir = join(canonicalSkillsRoot, name);
        if (!plannedSkillNames.includes(name)) plannedSkillNames.push(name);

        let dstStat = null;
        try {
          dstStat = lstatSync(dstDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
        }

        if (dstStat && dstStat.isDirectory()) {
          const beforeSnap = captureTreeSnapshot(dstDir);
          if (skillTreesMatch(srcDir, dstDir)) {
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
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    throw err;
  }

  return { installs, plannedSkillNames, tempDirs };
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

  copyTreeWithoutRootGit(item.srcDir, stagedPath);

  if (!item.isReplace) {
    // Destination must still be absent before publishing.
    if (existsSync(item.dstDir)) {
      rmSync(stagedPath, { recursive: true, force: true });
      throw new Error(
        `stale snapshot: ${item.dstDir} appeared after planning; refusing to overwrite`,
      );
    }
    renameSync(stagedPath, item.dstDir);
    fsyncDir(skillsRoot);
    return;
  }

  // Populated directory replacement: journaled same-filesystem backup+swap
  // (works cleanly on both Linux rename(2) and macOS). Ledger-neutral (targetGen === expectedGen).
  const backupPath = join(skillsRoot, `.backup-${item.name}-${opId}`);
  const afterSnapshot = captureTreeSnapshot(stagedPath);

  const journal: PendingJournalRecord = {
    version: 1,
    opId,
    hubPath: canonicalHubPath,
    expectedStateGeneration: state.generation,
    targetStateGeneration: state.generation, // ledger-neutral
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
  hooks?.beforeTargetMutate?.(journal);

  // Re-verify live destination matches planned snapshot strictly BEFORE mutating.
  const liveBefore = captureTreeSnapshot(item.dstDir);
  if (!snapshotsEqual(liveBefore, item.beforeSnapshot)) {
    rmSync(stagedPath, { recursive: true, force: true });
    clearJournal(journalPath);
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
