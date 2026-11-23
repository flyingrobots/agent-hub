/**
 * Project mode (flyingrobots/agent-hub#11): sync a repository's own hub, `<repo>/.agents/`, into
 * project-scoped agent configs, with ownership recorded in the committed `.agents/sync.lock.json`.
 *
 * The lockfile is attacker-controlled (anyone who can open a pull request writes it), so every
 * entry is validated before it is trusted: strictly repo-relative, contained in the repository's
 * real path with no symlinked ancestor, a member of the known output set for its kind, and
 * pruned only on an exact digest or link-target match. Any invalid entry fails the whole run
 * closed before anything is written. Project outputs are generated whole; the user's home
 * configs and user-scope ownership ledger are never read for writing or touched.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { loadCanonicalServers, type PlaintextSecretWarning, type VaultInvocation } from "./mcp.ts";
import { formatExplainBlock, formatOpSummary, opData, type OutputEvent, type SchemaId } from "./output.ts";
import { atomicWriteDurable, expandTilde, findDuplicateJsonKey, isPlainObject, sha256Hex } from "./paths.ts";
import { renderCodexSection } from "./toml-edit.ts";
import { resolveTargetScope, type AgentId, type PlannedOp, type SyncOptions, type SyncRunResult, type TargetScope } from "./types.ts";
import { findGrant, loadGrants, vaultStateDir } from "./vault.ts";

export const LOCK_REL = ".agents/sync.lock.json";

/** The agents project mode writes MCP config for. Antigravity's workspace path is unverified. */
const PROJECT_MCP_AGENTS = ["claude", "codex", "cursor", "opencode"] as const;

/** Every file project mode may write, prune or claim, and the agent that reads it. */
const FILE_OUTPUTS: Readonly<Record<string, AgentId>> = Object.freeze({
  ".mcp.json": "claude",
  ".cursor/mcp.json": "cursor",
  "opencode.json": "opencode",
  ".codex/config.toml": "codex",
});

const SKILL_LINK_RE = /^\.claude\/skills\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The only link target a known link path may have, or null when the path is not a known link. */
export function expectedLinkTarget(rel: string): string | null {
  if (rel === "CLAUDE.md" || rel === "AGENTS.md") return ".agents/AGENTS.md";
  const m = SKILL_LINK_RE.exec(rel);
  return m ? `../../.agents/skills/${m[1]}` : null;
}

/**
 * Validate a lockfile key (or an output path) without touching the disk: null when it is a
 * strictly repo-relative member of the known output set for its kind, else why it is not.
 */
export function validateLockEntryPath(rel: string, kind: "file" | "link"): string | null {
  if (typeof rel !== "string" || rel.length === 0) return "is empty";
  if (rel.includes("\0")) return "contains a NUL byte";
  if (rel.includes("\\")) return "contains a backslash";
  if (rel.startsWith("/")) return "is an absolute path";
  for (const seg of rel.split("/")) {
    if (seg === "") return "has an empty path segment";
    if (seg === "." || seg === "..") return `has a "${seg}" path segment`;
  }
  const known = kind === "file" ? Object.hasOwn(FILE_OUTPUTS, rel) : expectedLinkTarget(rel) !== null;
  return known ? null : `is not a project ${kind} sync-agents writes`;
}

class ProjectError extends Error {
  constructor(
    readonly code: "usage" | "config" | "hub_not_found" | "apply",
    message: string,
  ) {
    super(message);
  }
}

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Refuse a path whose existing ancestors are not plain directories inside the repository: a
 * symlinked ancestor (escaping or not) would let a write or prune land somewhere else.
 */
function ancestorProblem(repo: string, rel: string): string | null {
  const segs = rel.split("/");
  let cur = repo;
  for (let i = 0; i < segs.length - 1; i += 1) {
    cur = join(cur, segs[i]!);
    const shown = segs.slice(0, i + 1).join("/");
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(cur);
      } catch {
        return `${shown} is a dangling symlink`;
      }
      if (!inside(repo, real)) return `${shown} is a symlink that escapes the repository`;
      return `${shown} is a symlink; project mode never writes through a symlinked directory`;
    }
    if (!st.isDirectory()) return `${shown} is not a directory`;
  }
  return null;
}

type Lock = { files: Record<string, string>; links: Record<string, string> };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byCodeUnit(a, b)));

export function renderLock(lock: Lock): string {
  return `${JSON.stringify({ version: 1, files: sorted(lock.files), links: sorted(lock.links) }, null, 2)}\n`;
}

/** Parse and validate the committed lockfile; any doubt fails closed. */
function loadLock(repo: string): { lock: Lock; raw: string | null } {
  const p = join(repo, LOCK_REL);
  let st;
  try {
    st = lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lock: { files: {}, links: {} }, raw: null };
    throw err;
  }
  const bad = (why: string) => new ProjectError("config", `${LOCK_REL}: ${why}; nothing was written (fix it, or run sync-agents --project --relock)`);
  if (!st.isFile()) throw bad("is not a regular file");
  const raw = readFileSync(p, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw bad("is not valid JSON");
  }
  const dup = findDuplicateJsonKey(raw);
  if (dup) throw bad(`has a duplicate key "${dup.key}"`);
  if (!isPlainObject(doc)) throw bad("is not a JSON object");
  const extra = Object.keys(doc).filter((k) => k !== "version" && k !== "files" && k !== "links");
  if (extra.length > 0) throw bad(`has an unknown key "${extra[0]}"`);
  if (doc.version !== 1) throw bad('needs "version": 1');
  const lock: Lock = { files: {}, links: {} };
  for (const kind of ["files", "links"] as const) {
    const section = doc[kind];
    if (!isPlainObject(section)) throw bad(`"${kind}" must be an object`);
    for (const [rel, value] of Object.entries(section)) {
      const shown = JSON.stringify(rel);
      const why = validateLockEntryPath(rel, kind === "files" ? "file" : "link");
      if (why) throw bad(`${kind} entry ${shown} ${why}`);
      if (typeof value !== "string") throw bad(`${kind} entry ${shown} must be a string`);
      if (kind === "files" && !DIGEST_RE.test(value)) throw bad(`files entry ${shown} must be "sha256:<64 hex>"`);
      if (kind === "links" && value !== expectedLinkTarget(rel)) throw bad(`links entry ${shown} must point at ${JSON.stringify(expectedLinkTarget(rel))}`);
      const anc = ancestorProblem(repo, rel);
      if (anc) throw bad(`${kind} entry ${shown}: ${anc}`);
      lock[kind][rel] = value;
    }
  }
  return { lock, raw };
}

type Output = { rel: string; kind: "file" | "link"; domain: PlannedOp["domain"]; body: string };
type Observed = { kind: "absent" } | { kind: "file"; digest: string } | { kind: "link"; target: string } | { kind: "other" };

function observe(abs: string): Observed {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  if (st.isSymbolicLink()) return { kind: "link", target: readlinkSync(abs) };
  if (st.isFile()) return { kind: "file", digest: `sha256:${sha256Hex(readFileSync(abs))}` };
  return { kind: "other" };
}

const describe = (o: Observed) =>
  o.kind === "absent" ? "absent" : o.kind === "file" ? `file ${o.digest}` : o.kind === "link" ? `symlink -> ${o.target}` : "not a file or symlink";
const intendedOf = (out: Output) => (out.kind === "file" ? `sha256:${sha256Hex(out.body)}` : out.body);
const matches = (o: Observed, kind: "file" | "link", want: string) =>
  (kind === "file" && o.kind === "file" && o.digest === want) || (kind === "link" && o.kind === "link" && o.target === want);

/** Whether a known path is in this run's scope; excluded paths are never written or pruned. */
function pathInScope(rel: string, kind: "file" | "link", scope: TargetScope): boolean {
  if (kind === "file") return scope.mcp.has(FILE_OUTPUTS[rel]!);
  if (rel === "AGENTS.md") return ["codex", "cursor", "opencode"].some((a) => scope.links.has(a as AgentId));
  return scope.links.has("claude");
}

function resolveRepo(options: SyncOptions, cwd: string, homeDir: string): string {
  if (options.hubDir) {
    const abs = resolve(cwd, expandTilde(options.hubDir, homeDir));
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new ProjectError("config", `sync-agents --project: --dir ${abs} is not a directory`);
    return realpathSync(abs);
  }
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new ProjectError("config", `sync-agents --project: ${cwd} is not inside a git repository; run it from the repository or pass --dir <repo>`);
  }
  return realpathSync(r.stdout.trim());
}

/** The whole intended output set for this scope, from `<repo>/.agents/`. */
function intendedOutputs(
  hub: string,
  scope: TargetScope,
  warnings: PlaintextSecretWarning[],
  invocations: VaultInvocation[],
): Output[] {
  const outs: Output[] = [];
  const mcpAgents = new Set<AgentId>(PROJECT_MCP_AGENTS.filter((a) => scope.mcp.has(a)));
  // The bare launcher, so committed files are the same on every machine.
  const servers = loadCanonicalServers(hub, mcpAgents, warnings, { execPath: "sync-agents", invocations });
  const names = [...servers.keys()].sort(byCodeUnit);
  for (const [rel, agent] of Object.entries(FILE_OUTPUTS)) {
    if (!mcpAgents.has(agent)) continue;
    const entries: Array<[string, Record<string, unknown>]> = [];
    for (const n of names) {
      const e = servers.get(n)![agent];
      if (e) entries.push([n, e]);
    }
    if (entries.length === 0) continue;
    let body: string;
    if (agent === "codex") body = `${entries.map(([n, e]) => renderCodexSection(n, e)).join("\n\n")}\n`;
    else if (agent === "opencode") body = `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: Object.fromEntries(entries) }, null, 2)}\n`;
    else body = `${JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2)}\n`;
    outs.push({ rel, kind: "file", domain: "mcp", body });
  }
  const rules = join(hub, "AGENTS.md");
  if (existsSync(rules) && lstatSync(rules).isFile()) {
    for (const rel of ["AGENTS.md", "CLAUDE.md"]) {
      if (pathInScope(rel, "link", scope)) outs.push({ rel, kind: "link", domain: "rules", body: expectedLinkTarget(rel)! });
    }
  }
  const skills = join(hub, "skills");
  if (scope.links.has("claude") && existsSync(skills) && lstatSync(skills).isDirectory()) {
    for (const name of readdirSync(skills).sort(byCodeUnit)) {
      const rel = `.claude/skills/${name}`;
      if (validateLockEntryPath(rel, "link") !== null) continue;
      const dir = join(skills, name);
      if (!lstatSync(dir).isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
      outs.push({ rel, kind: "link", domain: "link", body: expectedLinkTarget(rel)! });
    }
  }
  return outs;
}

type Planned = { op: PlannedOp; rel: string; kind: "file" | "link"; observed: Observed; out?: Output; claim: boolean };

function mkOp(domain: PlannedOp["domain"], action: string, status: PlannedOp["status"], abs: string, o: Observed, intended: string, basis: string, reason: string, target: boolean, ledger: boolean, nextStep?: string): PlannedOp {
  return { domain, action, status, destination: abs, observed: describe(o), intended, ownershipBasis: basis, reason, targetMutation: target, ledgerMutation: ledger, ...(nextStep ? { nextStep } : {}) };
}

function planOutput(repo: string, out: Output, lock: Lock, flags: { adopt: boolean; force: boolean }): Planned {
  const abs = join(repo, out.rel);
  const o = observe(abs);
  const want = intendedOf(out);
  const locked = out.kind === "file" ? lock.files[out.rel] : lock.links[out.rel];
  const owned = locked !== undefined && matches(o, out.kind, locked);
  const p = (action: string, status: PlannedOp["status"], basis: string, reason: string, target: boolean, ledger: boolean, claim: boolean, next?: string): Planned => ({
    op: mkOp(out.domain, action, status, abs, o, want, basis, reason, target, ledger, next),
    rel: out.rel,
    kind: out.kind,
    observed: o,
    out,
    claim,
  });
  if (o.kind === "absent") return p("create", "change", "created", `create ${out.rel}`, true, locked !== want, true);
  if (matches(o, out.kind, want)) {
    if (owned) return p("ok", "ok", "lockfile", `${out.rel} is in sync`, false, false, true);
    if (flags.adopt) return p("adopt", "change", "adopted", `adopt ${out.rel}: it already equals the intended output`, false, true, true);
    return p("unmanaged-identical", "conflict", "none", `${out.rel} exists and is not owned in ${LOCK_REL}, though it equals the intended output`, false, false, false, "re-run with --adopt to take ownership");
  }
  if (o.kind === "other" || (out.kind === "file" && o.kind !== "file") || (out.kind === "link" && o.kind !== "link")) {
    return p("wrong-type", "conflict", locked ? "lockfile" : "none", `${out.rel} is ${describe(o)}; project mode will not replace it`, false, false, false, "move it aside, then re-run");
  }
  if (owned) return p("rewrite", "change", "lockfile", `rewrite ${out.rel} for the hub's current contents`, true, true, true);
  if (locked !== undefined) {
    if (flags.force) return p("force-rewrite", "change", "forced", `rewrite ${out.rel}, replacing local edits (--force)`, true, true, true);
    return p("modified", "conflict", "lockfile", `${out.rel} was edited after sync-agents wrote it`, false, false, false, "move your edits into .agents/ and re-run with --force, or run --relock");
  }
  return p("unmanaged", "conflict", "none", `${out.rel} exists, is not owned in ${LOCK_REL}, and differs from the intended output`, false, false, false, "move it aside (or fold it into .agents/), then re-run");
}

function planPrune(repo: string, rel: string, kind: "file" | "link", locked: string): Planned {
  const abs = join(repo, rel);
  const o = observe(abs);
  const domain: PlannedOp["domain"] = kind === "file" ? "mcp" : rel.startsWith(".claude/") ? "link" : "rules";
  const base = { rel, kind, observed: o, claim: false };
  if (o.kind === "absent") return { ...base, op: mkOp(domain, "forget", "change", abs, o, "absent", "lockfile", `forget ${rel}: no longer intended and already gone`, false, true) };
  if (matches(o, kind, locked)) return { ...base, op: mkOp(domain, "prune", "change", abs, o, "absent", "lockfile", `remove ${rel}: no longer intended`, true, true) };
  return {
    ...base,
    claim: true,
    op: mkOp(domain, "prune-mismatch", "conflict", abs, o, "absent", "lockfile", `${rel} is no longer intended but differs from what sync-agents wrote; it was left alone`, false, false, "delete it yourself if you do not need it, then re-run"),
  };
}

function writeLink(abs: string, target: string): void {
  mkdirSync(join(abs, ".."), { recursive: true });
  const tmp = `${abs}.sync-agents-${process.pid}.tmp`;
  symlinkSync(target, tmp);
  renameSync(tmp, abs);
}

export function runProjectSync(options: SyncOptions): SyncRunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const events: OutputEvent[] = [];
  const emit = (stream: "stdout" | "stderr", id: SchemaId, message: string, data: Record<string, unknown> = {}) => {
    const event: OutputEvent = { stream, id, message, data };
    events.push(event);
    (stream === "stdout" ? stdout : stderr).push(message);
    options.onEvent?.(event);
  };
  const done = (exitCode: number): SyncRunResult => ({ exitCode, stdout, stderr, events });
  const label = "sync-agents --project";
  const checkOnly = Boolean(options.checkOnly);
  const explain = Boolean(options.explain);
  const relock = Boolean(options.relock);
  const dryRun = Boolean(options.dryRun || checkOnly || explain);

  const usage = (msg: string) => {
    emit("stderr", "agent_hub.error", `${label}: ${msg}`, { code: "usage" });
    return done(2);
  };
  if (options.mcpOnly) return usage("mcp-sync does not support --project; use sync-agents --project");
  if ((options.skillSources ?? []).length > 0 || options.skillOnly) return usage("--skill cannot be combined with --project; install the skill into <repo>/.agents/skills/ yourself");
  if ((options.disownLegacy ?? []).length > 0) return usage("--disown-legacy is a user-scope option");
  if (relock && (checkOnly || explain)) return usage("--relock cannot be combined with --check or --explain (use --relock --dry-run)");
  if (relock && options.targets) return usage("--relock rebuilds the whole lockfile and cannot be combined with --targets");

  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  try {
    const repo = resolveRepo(options, cwd, homeDir);
    const hub = join(repo, ".agents");
    let hubSt;
    try {
      hubSt = lstatSync(hub);
    } catch {
      throw new ProjectError("hub_not_found", `${label}: project hub not found: ${hub}`);
    }
    if (hubSt.isSymbolicLink()) throw new ProjectError("config", `${label}: ${hub} is a symlink; project mode reads and writes only a real .agents/ directory`);
    if (!hubSt.isDirectory()) throw new ProjectError("hub_not_found", `${label}: project hub not found: ${hub}`);

    // Project scope never reads the user's disabledTargets: committed outputs must not depend on
    // one machine's config. Only --targets narrows a run.
    const scope = resolveTargetScope(options.targets, []);
    const { lock, raw } = relock ? { lock: { files: {}, links: {} } as Lock, raw: existsSync(join(repo, LOCK_REL)) ? readFileSync(join(repo, LOCK_REL), "utf8") : null } : loadLock(repo);

    const warnings: PlaintextSecretWarning[] = [];
    const invocations: VaultInvocation[] = [];
    let outs: Output[];
    try {
      outs = intendedOutputs(hub, scope, warnings, invocations);
    } catch (err) {
      throw new ProjectError("config", `${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (warnings.length > 0) {
      for (const w of warnings) {
        emit("stderr", "agent_hub.warning", `[warn] mcp/${w.server}: ${w.field} ${w.reason}; write it as \${env:NAME} or \${vault:KEY}`, {
          code: "plaintext_secret",
          server: w.server,
          field: w.field,
          reason: w.reason,
          source: w.source,
        });
      }
      throw new ProjectError("config", `${label}: refusing to write ${warnings.length} plaintext secret(s) into committed project files; nothing was written`);
    }
    for (const out of outs) {
      const anc = ancestorProblem(repo, out.rel);
      if (anc) throw new ProjectError("config", `${label}: ${out.rel}: ${anc}; nothing was written`);
    }

    const flags = { adopt: Boolean(options.adopt), force: Boolean(options.force) };
    const plans: Planned[] = [];
    if (relock) {
      for (const out of outs) {
        const abs = join(repo, out.rel);
        const o = observe(abs);
        const want = intendedOf(out);
        const eq = matches(o, out.kind, want);
        plans.push({
          rel: out.rel,
          kind: out.kind,
          observed: o,
          out,
          claim: eq,
          op: eq
            ? mkOp(out.domain, "relock-claim", "ok", abs, o, want, "relock", `${out.rel} equals the intended output; claimed`, false, true)
            : mkOp(out.domain, "relock-skip", "ok", abs, o, want, "none", `${out.rel} is ${o.kind === "absent" ? "absent" : "not the intended output"}; not claimed`, false, false),
        });
      }
    } else {
      const intendedRels = new Set(outs.map((o) => `${o.kind}\0${o.rel}`));
      for (const out of outs) plans.push(planOutput(repo, out, lock, flags));
      for (const [kind, section] of [["file", lock.files], ["link", lock.links]] as const) {
        for (const [rel, locked] of Object.entries(section)) {
          if (intendedRels.has(`${kind}\0${rel}`) || !pathInScope(rel, kind, scope)) continue;
          plans.push(planPrune(repo, rel, kind, locked));
        }
      }
    }

    // The next lockfile: out-of-scope entries carried over, then every path this run owns.
    const next: Lock = { files: {}, links: {} };
    if (!relock) {
      for (const [rel, v] of Object.entries(lock.files)) if (!pathInScope(rel, "file", scope)) next.files[rel] = v;
      for (const [rel, v] of Object.entries(lock.links)) if (!pathInScope(rel, "link", scope)) next.links[rel] = v;
    }
    for (const pl of plans) {
      if (!pl.claim) continue;
      const section = pl.kind === "file" ? next.files : next.links;
      if (pl.out) section[pl.rel] = intendedOf(pl.out);
      else section[pl.rel] = (pl.kind === "file" ? lock.files : lock.links)[pl.rel]!;
    }
    const empty = Object.keys(next.files).length === 0 && Object.keys(next.links).length === 0;
    const nextRaw = renderLock(next);
    const lockChanges = raw === null ? !empty : raw !== nextRaw;

    const conflictPlans = plans.filter((p) => p.op.status === "conflict");
    const changePlans = plans.filter((p) => p.op.status === "change");
    const changes = changePlans.length + (lockChanges ? 1 : 0);

    // Vault keys this machine has not granted: a hint only. Grants are machine-local and never
    // created here; `secret grant` is the explicit, per-key confirmation.
    let grantHint = "";
    if (invocations.length > 0) {
      try {
        const grants = loadGrants(vaultStateDir(homeDir, options.xdgStateHome ?? process.env.XDG_STATE_HOME));
        const missing = new Map<string, string>();
        for (const v of invocations) if (!findGrant(grants, v, v.argv)) missing.set(`${v.server}\0${v.key}`, `sync-agents secret grant ${v.key} --to ${v.server} --dir ${hub}`);
        if (missing.size > 0) grantHint = ` ${missing.size} vault key(s) have no grant on this machine; exec refuses them until you run: ${[...missing.values()].join("; ")}`;
      } catch {
        grantHint = " The machine's vault grants could not be read; exec refuses vault keys until grants.json is fixed.";
      }
    }

    const opEvent = (phase: "plan" | "sync" | "explain", op: PlannedOp) =>
      emit("stdout", "agent_hub.op", phase === "explain" ? formatExplainBlock(op).join("\n") : formatOpSummary(phase, op), { phase, op: opData(op) });
    const emitConflicts = () => {
      for (const c of conflictPlans) {
        const nx = c.op.nextStep ? ` (${c.op.nextStep})` : "";
        emit("stderr", "agent_hub.conflict", `[conflict] ${c.op.reason}${nx}`, { reason: c.op.reason, ...(c.op.nextStep ? { next_step: c.op.nextStep } : {}), op: opData(c.op) });
      }
    };

    if (dryRun) {
      for (const pl of plans) {
        if (explain) opEvent("explain", pl.op);
        else if (pl.op.status === "change" || (relock && pl.op.ledgerMutation)) opEvent("plan", pl.op);
      }
      if (conflictPlans.length > 0) {
        emitConflicts();
        emit("stderr", "agent_hub.summary", `${label}: ${conflictPlans.length} conflict(s) found.`, { status: "conflicts", conflicts: conflictPlans.length });
        return done(1);
      }
      const lockNote = lockChanges ? ` ${LOCK_REL} needs updating.` : "";
      if (checkOnly && changes > 0) {
        emit("stderr", "agent_hub.summary", `${label}: out of sync (${changes} change(s) needed).${lockNote}`, { status: "out_of_sync", changes });
        return done(1);
      }
      if (changes === 0) emit("stdout", "agent_hub.summary", `${label}: everything is in sync.${grantHint}`, { status: "in_sync", changes: 0 });
      else emit("stdout", "agent_hub.summary", `${label}: ${changes} change(s) planned; nothing was changed.${lockNote}${grantHint}`, { status: "planned", changes });
      return done(0);
    }

    if (conflictPlans.length > 0) {
      emitConflicts();
      emit("stderr", "agent_hub.summary", `${label}: ${conflictPlans.length} conflict(s) found; nothing was written.`, { status: "conflicts", conflicts: conflictPlans.length });
      return done(1);
    }

    // Apply: outputs first, the lockfile last, so the lock never claims bytes that are not on
    // disk. An interrupted run leaves unclaimed identical outputs: --adopt or --relock takes them.
    let applied = 0;
    for (const pl of changePlans) {
      const abs = join(repo, pl.rel);
      const anc = ancestorProblem(repo, pl.rel);
      if (anc) throw new ProjectError("apply", `${label}: ${pl.rel}: ${anc}`);
      const now = observe(abs);
      if (describe(now) !== describe(pl.observed)) throw new ProjectError("apply", `${label}: ${pl.rel} changed while planning; nothing further was written (re-run)`);
      if (pl.op.targetMutation) {
        if (pl.op.action === "prune") unlinkSync(abs);
        else if (pl.kind === "file") atomicWriteDurable(abs, pl.out!.body, 0o644);
        else writeLink(abs, pl.out!.body);
      }
      applied += 1;
      opEvent("sync", pl.op);
    }
    if (lockChanges) {
      atomicWriteDurable(join(repo, LOCK_REL), nextRaw, 0o644);
      applied += changePlans.length === 0 ? 1 : 0;
    }
    if (applied === 0 && !lockChanges) {
      emit("stdout", "agent_hub.summary", `${label}: everything is in sync.${grantHint}`, { status: "in_sync", changes: 0 });
    } else {
      emit("stdout", "agent_hub.summary", `${label}: applied ${changes} change(s)${lockChanges ? ` and updated ${LOCK_REL}` : ""}.${grantHint}`, { status: "applied", changes });
    }
    return done(0);
  } catch (err) {
    const code = err instanceof ProjectError ? err.code : "plan";
    const msg = err instanceof Error ? err.message : String(err);
    emit("stderr", "agent_hub.error", msg.startsWith("sync-agents") ? msg : `${label}: ${msg}`, { code });
    return done(code === "usage" ? 2 : 1);
  }
}
