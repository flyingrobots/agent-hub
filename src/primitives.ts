/**
 * Phase 7 (flyingrobots/agent-hub#12): slash commands and agent definitions written once in the
 * hub (`<hub>/commands/<name>.md`, `<hub>/agents/<name>.md`) and generated into each agent's own
 * user directory, in that agent's own format. Only a portable subset of frontmatter is accepted
 * at the top level; anything one agent alone understands goes under `targets.<agent>`. Generated
 * files are owned by digest, like MCP entries: created, updated, adopted, pruned, or refused.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  atomicWriteDurable,
  captureFileSnapshot,
  fsyncDir,
  isPlainObject,
  predictNewEntryOwner,
  sha256Hex,
  snapshotsEqual,
} from "./paths.ts";
import { applyStateDelta, clearJournal, saveOwnershipState, writeJournal } from "./state.ts";
import type {
  AgentId,
  ApplyHooks,
  ManagedFileRecord,
  OwnershipBasis,
  OwnershipStateV2,
  PendingJournalRecord,
  PlannedOp,
  StateDelta,
  TargetSnapshot,
} from "./types.ts";

type Kind = "command" | "agent";
type Format = "md" | "md-body" | "toml";

/** Where each agent reads user-scope commands and agents (null: not supported or deprecated). */
type PrimitiveTarget = {
  agent: AgentId;
  root: (home: string, configBase: string) => string;
  commands: { dir: string; format: Format } | null;
  agents: { dir: string; format: Format } | null;
};

export const PRIMITIVE_TARGETS: readonly PrimitiveTarget[] = [
  {
    agent: "claude",
    root: (h) => join(h, ".claude"),
    commands: { dir: "commands", format: "md" },
    agents: { dir: "agents", format: "md" },
  },
  {
    agent: "opencode",
    root: (_h, c) => join(c, "opencode"),
    commands: { dir: "commands", format: "md" },
    agents: { dir: "agents", format: "md" },
  },
  {
    // Cursor commands are plain Markdown (no frontmatter); its agents take name/description.
    agent: "cursor",
    root: (h) => join(h, ".cursor"),
    commands: { dir: "commands", format: "md-body" },
    agents: { dir: "agents", format: "md" },
  },
  {
    // ~/.codex/prompts is deprecated in favour of skills; Codex agents are TOML.
    agent: "codex",
    root: (h) => join(h, ".codex"),
    commands: null,
    agents: { dir: "agents", format: "toml" },
  },
] as const;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export class PrimitiveError extends Error {}

type Source = { kind: Kind; name: string; path: string; front: Record<string, unknown>; body: string };

function parseSource(kind: Kind, path: string, name: string): Source {
  // One line ending and no BOM, so frontmatter is always recognised and never passed through
  // unvalidated as part of the body.
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let front: Record<string, unknown> = {};
  let body = text;
  const m = /^---[ \t]*\n([\s\S]*?)^---[ \t]*(?:\n|$)/m.exec(text);
  if (m && m.index === 0) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(m[1] ?? "");
    } catch (err) {
      throw new PrimitiveError(`${path}: frontmatter is not valid YAML (${err instanceof Error ? err.message : String(err)})`);
    }
    if (parsed !== null && parsed !== undefined && !isPlainObject(parsed)) throw new PrimitiveError(`${path}: frontmatter must be a mapping`);
    front = (parsed as Record<string, unknown>) ?? {};
    body = text.slice(m[0].length);
  } else if (/^\s*---/.test(text)) {
    throw new PrimitiveError(`${path}: frontmatter must open with "---" on the first line and close with a "---" line`);
  }
  return { kind, name, path, front, body };
}

const PORTABLE: Record<Kind, string[]> = {
  command: ["description", "argument-hint", "targets"],
  agent: ["description", "model", "targets"],
};
const TARGETABLE = new Set<AgentId>(["claude", "opencode", "cursor", "codex"]);

/** Refuse anything that would mean different things to different agents. */
function validate(src: Source): void {
  const where = `${src.kind === "command" ? "commands" : "agents"}/${src.name}.md`;
  if (!NAME.test(src.name)) {
    throw new PrimitiveError(`${where}: the name must match ^[a-z0-9][a-z0-9-]*$ (it becomes each agent's file name)`);
  }
  for (const k of Object.keys(src.front)) {
    if (!PORTABLE[src.kind].includes(k)) {
      throw new PrimitiveError(
        `${where}: "${k}" is not portable across agents (tool names, models and permissions differ); put it under targets.<agent> for the agent it is meant for`,
      );
    }
  }
  for (const k of ["description", "argument-hint"]) {
    if (src.front[k] !== undefined && typeof src.front[k] !== "string") throw new PrimitiveError(`${where}: ${k} must be a string`);
  }
  if (src.kind === "agent") {
    if (typeof src.front.description !== "string" || src.front.description.length === 0) {
      throw new PrimitiveError(`${where}: an agent needs a description (agents choose subagents by it)`);
    }
    if (src.front.model !== undefined && src.front.model !== "inherit") {
      throw new PrimitiveError(`${where}: model may only be "inherit" here (model names differ per agent); set a model under targets.<agent>`);
    }
    if (src.body.trim().length === 0) throw new PrimitiveError(`${where}: the body (the agent's instructions) is empty`);
  } else {
    if (/\$[0-9]/.test(src.body)) {
      throw new PrimitiveError(`${where}: positional placeholders ($1, $2...) count from different places in different agents; use $ARGUMENTS`);
    }
    if (src.body.includes("!`")) throw new PrimitiveError(`${where}: shell injection (!\`...\`) is not portable; put such a command in one agent's own directory`);
  }
  const targets = src.front.targets;
  if (targets !== undefined) {
    if (!isPlainObject(targets)) throw new PrimitiveError(`${where}: targets must map agent names to frontmatter`);
    for (const [agent, extra] of Object.entries(targets)) {
      if (!TARGETABLE.has(agent as AgentId)) throw new PrimitiveError(`${where}: targets.${agent} is not an agent that receives ${src.kind}s`);
      if (!isPlainObject(extra)) throw new PrimitiveError(`${where}: targets.${agent} must be a mapping`);
      if (agent === "cursor" && src.kind === "command" && Object.keys(extra).length > 0) {
        throw new PrimitiveError(`${where}: Cursor commands are plain Markdown and take no frontmatter (targets.cursor)`);
      }
    }
  }
}

function yamlFront(obj: Record<string, unknown>): string {
  return Object.keys(obj).length === 0 ? "" : `---\n${Bun.YAML.stringify(obj, null, 2).trimEnd()}\n---\n`;
}

/** A TOML basic string: JSON's escapes, plus DEL, which TOML forbids raw. */
function tomlString(v: string): string {
  return JSON.stringify(v).replace(/\u007f/g, "\\u007F");
}
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** The file one agent receives for one source. */
function render(src: Source, t: PrimitiveTarget, format: Format): string {
  const extra = ((src.front.targets as Record<string, Record<string, unknown>> | undefined)?.[t.agent] ?? {}) as Record<string, unknown>;
  const desc = src.front.description as string | undefined;
  if (format === "md-body") return src.body;
  if (format === "toml") {
    const lines = [`name = ${tomlString(src.name)}`, `description = ${tomlString(desc ?? "")}`, `developer_instructions = ${tomlString(src.body)}`];
    for (const [k, v] of Object.entries(extra).sort(([a], [b]) => a.localeCompare(b))) {
      const where = `agents/${src.name}.md: targets.codex.${k}`;
      if (["name", "description", "developer_instructions"].includes(k)) throw new PrimitiveError(`${where} is written by sync-agents itself`);
      const key = TOML_BARE_KEY.test(k) ? k : tomlString(k);
      if (k.length === 0) throw new PrimitiveError(`agents/${src.name}.md: targets.codex has an empty key`);
      if (typeof v === "string") lines.push(`${key} = ${tomlString(v)}`);
      else if (typeof v === "boolean") lines.push(`${key} = ${String(v)}`);
      else if (typeof v === "number" && Number.isSafeInteger(v)) lines.push(`${key} = ${String(v)}`);
      else if (typeof v === "number" && Number.isFinite(v)) lines.push(`${key} = ${String(v).includes(".") || String(v).includes("e") ? String(v) : `${v}.0`}`);
      else throw new PrimitiveError(`${where} must be a string, a boolean, or a finite number within 64-bit range`);
    }
    const toml = `${lines.join("\n")}\n`;
    try {
      Bun.TOML.parse(toml);
    } catch (err) {
      throw new PrimitiveError(`agents/${src.name}.md: the Codex TOML would not parse (${err instanceof Error ? err.message : String(err)})`);
    }
    return toml;
  }
  const front: Record<string, unknown> = {};
  if (src.kind === "command") {
    if (desc !== undefined) front.description = desc;
    if (t.agent === "claude" && src.front["argument-hint"] !== undefined) front["argument-hint"] = src.front["argument-hint"];
  } else if (t.agent === "opencode") {
    // OpenCode names agents by file and defaults a new one to a primary agent.
    front.description = desc;
    front.mode = "subagent";
  } else {
    front.name = src.name;
    front.description = desc;
    if (t.agent === "claude" && src.front.model === "inherit") front.model = "inherit";
  }
  Object.assign(front, extra);
  return `${yamlFront(front)}${src.body}`;
}

export type DesiredFile = { dst: string; content: string; kind: Kind; agent: AgentId; source: string };

/** Every file the hub's commands and agents produce for the active, installed agents. */
export function desiredPrimitiveFiles(
  hub: string,
  home: string,
  configBase: string,
  active: ReadonlySet<AgentId>,
): DesiredFile[] {
  const sources: Source[] = [];
  for (const kind of ["command", "agent"] as const) {
    const dir = join(hub, kind === "command" ? "commands" : "agents");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".md") || f.startsWith(".") || f === "README.md") continue;
      if (!statSync(join(dir, f)).isFile()) continue;
      const src = parseSource(kind, join(dir, f), f.slice(0, -3));
      validate(src);
      sources.push(src);
    }
  }
  const out: DesiredFile[] = [];
  const hubReal = realpathSync(hub);
  const seen = new Map<string, string>();
  // Where a destination really is: its parent resolved (the file itself may not exist yet).
  const physical = (dst: string): string => {
    let dir = dirname(dst);
    const rest: string[] = [dst.slice(dir.length + 1)];
    while (!existsSync(dir) && dir !== dirname(dir)) {
      rest.unshift(dir.slice(dirname(dir).length + 1));
      dir = dirname(dir);
    }
    return join(realpathSync(dir), ...rest);
  };
  for (const t of PRIMITIVE_TARGETS) {
    if (!active.has(t.agent) || !existsSync(t.root(home, configBase))) continue;
    for (const src of sources) {
      const where = src.kind === "command" ? t.commands : t.agents;
      if (!where) continue;
      const ext = where.format === "toml" ? "toml" : "md";
      const dst = join(t.root(home, configBase), where.dir, `${src.name}.${ext}`);
      const phys = physical(dst);
      if (phys === hubReal || phys.startsWith(`${hubReal}${sep}`)) {
        throw new PrimitiveError(`${dst} resolves into the hub (${phys}); a symlinked ${t.agent} ${where.dir} directory would overwrite the hub's own files. Make ${dirname(dst)} a real directory`);
      }
      const other = seen.get(phys);
      if (other !== undefined) {
        throw new PrimitiveError(`${dst} and ${other} are the same file (${phys}): two agents' ${where.dir} directories are linked, and each needs its own format. Make one of them a real directory`);
      }
      seen.set(phys, dst);
      out.push({
        dst,
        content: render(src, t, where.format),
        kind: src.kind,
        agent: t.agent,
        source: src.path,
      });
    }
  }
  return out;
}

/** The agent whose primitives directory holds dst, under the current HOME and config base. */
export function primitiveOwner(dst: string, home: string, configBase: string): AgentId | null {
  for (const t of PRIMITIVE_TARGETS) {
    for (const where of [t.commands, t.agents]) {
      if (!where) continue;
      const dir = join(t.root(home, configBase), where.dir);
      if (dst.startsWith(`${dir}${sep}`) && !dst.slice(dir.length + 1).includes(sep)) return t.agent;
    }
  }
  return null;
}

export type PlannedFileOp = {
  op: PlannedOp;
  action: "create" | "update" | "adopt" | "refresh" | "delete" | "drop" | "none";
  dst: string;
  kind: Kind;
  content?: string;
  /** "managed" only on refusals, which write no record. */
  basis: OwnershipBasis | "managed";
  before: TargetSnapshot;
};

const MODE = 0o644;

/** Plan every generated file against the ledger and what is on disk. */
export function planPrimitives(
  hub: string,
  home: string,
  configBase: string,
  state: OwnershipStateV2,
  active: ReadonlySet<AgentId>,
  flags: { adopt: boolean; force: boolean },
): PlannedFileOp[] {
  const plans: PlannedFileOp[] = [];
  const desired = desiredPrimitiveFiles(hub, home, configBase, active);
  const desiredDst = new Set(desired.map((d) => d.dst));
  const mk = (
    action: PlannedFileOp["action"],
    d: { dst: string; kind: Kind },
    status: PlannedOp["status"],
    observed: string,
    intended: string,
    reason: string,
    basis: OwnershipBasis | "managed",
    before: TargetSnapshot,
    extra: Partial<PlannedFileOp> & { nextStep?: string } = {},
  ): PlannedFileOp => ({
    action,
    dst: d.dst,
    kind: d.kind,
    basis,
    before,
    ...extra,
    op: {
      domain: "link",
      action: action === "none" ? "file-unchanged" : `file-${action}`,
      status,
      destination: d.dst,
      observed,
      intended,
      ownershipBasis: basis,
      reason,
      ...(extra.nextStep ? { nextStep: extra.nextStep } : {}),
      targetMutation: action === "create" || action === "update" || action === "delete",
      ledgerMutation: action !== "none",
    },
  });

  for (const d of desired) {
    const before = captureFileSnapshot(d.dst);
    const rec = state.files[d.dst];
    const want = sha256Hex(d.content);
    if (before.kind === "symlink" || before.kind === "tree") {
      plans.push(mk("none", d, "conflict", `${d.dst} is a ${before.kind === "symlink" ? "symlink" : "directory"}`, `write the ${d.kind} file`, `${d.dst} is not a regular file; refusing to replace it`, "managed", before, { nextStep: "Move it aside, then run sync-agents again" }));
      continue;
    }
    if (before.kind === "absent") {
      plans.push(mk("create", d, "change", "absent", `write the ${d.kind} generated from ${d.source}`, "the agent does not have it yet", rec?.basis ?? "created", before, { content: d.content }));
      continue;
    }
    if (before.sha256 === want) {
      if (rec && rec.digest === want) plans.push(mk("none", d, "ok", "matches the hub", "nothing", "in sync", rec.basis, before));
      else if (rec) plans.push(mk("refresh", d, "change", "matches the hub; the ledger has an older digest", "update the ledger", "already written", rec.basis, before, { content: d.content }));
      else if (flags.adopt) plans.push(mk("adopt", d, "change", "an identical file agent-hub did not write", "record it as owned", "--adopt", "adopted", before, { content: d.content }));
      else plans.push(mk("none", d, "conflict", "an identical file agent-hub did not write", "own it", `${d.dst} exists and agent-hub did not write it`, "managed", before, { nextStep: "Run sync-agents --adopt to record it as owned" }));
      continue;
    }
    if (rec && before.sha256 === rec.digest) {
      plans.push(mk("update", d, "change", "the file agent-hub wrote", `rewrite it from ${d.source}`, "the hub changed", rec.basis, before, { content: d.content }));
    } else if (flags.force) {
      plans.push(mk("update", d, "change", rec ? "edited since agent-hub wrote it" : "a different file agent-hub did not write", `replace it from ${d.source}`, "--force", "forced", before, { content: d.content }));
    } else {
      plans.push(mk("none", d, "conflict", rec ? "edited since agent-hub wrote it" : "a different file agent-hub did not write", `write the ${d.kind} generated from ${d.source}`, `refusing to overwrite ${d.dst}`, "managed", before, { nextStep: "Move your version aside, or pass --force to replace it" }));
    }
  }

  for (const [dst, rec] of Object.entries(state.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (desiredDst.has(dst)) continue;
    const owner = primitiveOwner(dst, home, configBase);
    if (owner === null || !active.has(owner)) continue;
    const before = captureFileSnapshot(dst);
    const d = { dst, kind: rec.kind };
    if (before.kind === "absent") {
      plans.push(mk("drop", d, "change", "already absent", "forget it", "it is no longer in the hub", rec.basis, before));
    } else if (before.kind === "file" && before.sha256 === rec.digest) {
      plans.push(mk("delete", d, "change", "the file agent-hub wrote", "delete it", "it is no longer in the hub", rec.basis, before));
    } else if (flags.force && before.kind === "file") {
      plans.push(mk("delete", d, "change", "edited since agent-hub wrote it", "delete it", "--force; it is no longer in the hub", rec.basis, before));
    } else {
      plans.push(mk("none", d, "conflict", "edited since agent-hub wrote it", "delete it", `refusing to delete ${dst}: it changed since agent-hub wrote it`, rec.basis, before, { nextStep: "Delete it yourself, or pass --force" }));
    }
  }
  return plans;
}

/** Apply one planned file op: journaled write or delete, or a ledger-only change. */
export function applyFileOp(
  plan: PlannedFileOp,
  hubPath: string,
  state: OwnershipStateV2,
  statePath: string,
  journalPath: string,
  flags: { adopt: boolean; force: boolean; forceSkill: boolean },
  hooks?: ApplyHooks,
): OwnershipStateV2 {
  if (plan.op.status !== "change") return state;
  const now = new Date().toISOString();
  const basis: OwnershipBasis = plan.basis === "managed" ? "created" : plan.basis;
  const record = (digest: string): ManagedFileRecord => ({ kind: plan.kind, digest, basis, updatedAt: now });
  const live = captureFileSnapshot(plan.dst);
  if (!snapshotsEqual(live, plan.before)) {
    throw new Error(`stale snapshot: ${plan.dst} changed after planning; refusing to touch it`);
  }
  if (plan.action === "adopt" || plan.action === "refresh" || plan.action === "drop") {
    const delta: StateDelta =
      plan.action === "drop"
        ? { kind: "file-delete", destination: plan.dst }
        : { kind: "file-set", destination: plan.dst, record: record(sha256Hex(plan.content!)) };
    hooks?.beforeLedgerOnlyCommit?.(`file-${plan.action} ${plan.dst}`);
    const next = applyStateDelta(state, delta);
    saveOwnershipState(statePath, next);
    return next;
  }
  const writing = plan.action === "create" || plan.action === "update";
  const owner = live.kind === "file" ? { uid: live.uid, gid: live.gid } : predictNewEntryOwner(dirname(plan.dst));
  const after: TargetSnapshot = writing
    ? { kind: "file", sha256: sha256Hex(plan.content!), mode: live.kind === "file" ? live.mode : MODE, uid: owner.uid, gid: owner.gid }
    : { kind: "absent" };
  const delta: StateDelta = writing
    ? { kind: "file-set", destination: plan.dst, record: record(sha256Hex(plan.content!)) }
    : { kind: "file-delete", destination: plan.dst };
  const journal: PendingJournalRecord = {
    version: 1,
    opId: `file-${Date.now()}-${randomBytes(4).toString("hex")}`,
    hubPath,
    expectedStateGeneration: state.generation,
    targetStateGeneration: state.generation + 1,
    kind: writing ? "file-write" : "file-delete",
    authorization: { flags, basis: plan.basis, reason: plan.op.reason },
    destination: plan.dst,
    before: plan.before,
    after,
    stateDelta: delta,
  };
  writeJournal(journalPath, journal);
  hooks?.beforeTargetMutate?.(journal);
  if (writing) {
    atomicWriteDurable(plan.dst, plan.content!, MODE);
  } else {
    unlinkSync(plan.dst);
    fsyncDir(dirname(plan.dst));
  }
  hooks?.afterTargetMutate?.(journal);
  const next = applyStateDelta(state, delta);
  saveOwnershipState(statePath, next);
  hooks?.afterStateCommit?.(journal);
  clearJournal(journalPath);
  return next;
}
