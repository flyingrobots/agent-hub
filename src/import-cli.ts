/**
 * `sync-agents import` and `sync-agents pull` (flyingrobots/agent-hub#7). Both plan by default
 * and write only with --apply; any refusal means nothing is written. Output uses the same event
 * contract as a sync (docs/topics/output).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { LINK_TARGETS, linkTargetRoot, MCP_ADAPTER_BY_ID, xdgConfigBase } from "./adapters.ts";
import { runSync } from "./cli.ts";
import { detectPlaintextSecrets } from "./env-refs.ts";
import {
  aggregateServers,
  decompileEntry,
  minimalOverride,
  orderedSpec,
  rewritePlaintextSecrets,
  roundTripDiff,
} from "./import.ts";
import { mergeSpec, parseSpecSnippet } from "./mcp.ts";
import type { OutputEvent, SchemaId } from "./output.ts";
import { atomicWriteDurable, canonicalizeHubPath, isPlainObject, parseStrictJsonTargetFile, stableJson } from "./paths.ts";
import { ALL_AGENTS, type AgentId, type McpServerSpec, type PlannedOp, type SyncOptions } from "./types.ts";

export type ImportOptions = {
  hubDir: string;
  homeDir?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  from?: AgentId;
  only?: "rules" | "skills" | "mcp";
  rewriteSecrets?: boolean;
  apply?: boolean;
  adopt?: boolean;
  onEvent?: (e: OutputEvent) => void;
};

export type PullOptions = Omit<ImportOptions, "only" | "adopt"> & {
  from: AgentId;
  item: { kind: "mcp" | "skill"; name: string };
  asOverride?: boolean;
};

type Run = { exitCode: number; events: OutputEvent[] };

function recorder(onEvent?: (e: OutputEvent) => void) {
  const events: OutputEvent[] = [];
  const emit = (stream: "stdout" | "stderr", id: SchemaId, message: string, data: Record<string, unknown> = {}) => {
    const e: OutputEvent = { stream, id, message, data };
    events.push(e);
    onEvent?.(e);
  };
  const op = (phase: "plan" | "sync", o: PlannedOp, message: string) =>
    emit("stdout", "agent_hub.op", message, {
      phase,
      op: {
        domain: o.domain,
        action: o.action,
        status: o.status,
        destination: o.destination,
        observed: o.observed,
        intended: o.intended,
        ownership_basis: o.ownershipBasis,
        reason: o.reason,
        ...(o.nextStep ? { next_step: o.nextStep } : {}),
        target_mutation: o.targetMutation,
        ledger_mutation: o.ledgerMutation,
      },
    });
  const conflict = (reason: string, nextStep?: string) =>
    emit("stderr", "agent_hub.conflict", `[conflict] ${reason}${nextStep ? ` (${nextStep})` : ""}`, {
      reason,
      ...(nextStep ? { next_step: nextStep } : {}),
    });
  /** The op lines with phase sync printed so far: what an applied summary counts. */
  const applied = () => events.filter((e) => e.id === "agent_hub.op" && e.data.phase === "sync").length;
  return { events, emit, op, conflict, applied };
}

/** Every server an agent's config holds now, or null when the agent is not installed. */
export function readNativeMcp(agent: AgentId, homeDir: string, configBase: string): Map<string, unknown> | null {
  const adapter = MCP_ADAPTER_BY_ID[agent];
  if (!existsSync(adapter.rootDir(homeDir, configBase))) return null;
  const path = adapter.configPath(homeDir, configBase);
  const out = new Map<string, unknown>();
  if (!existsSync(path)) return out;
  let map: unknown;
  if (adapter.format === "toml") {
    map = (Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>).mcp_servers;
  } else {
    const doc = parseStrictJsonTargetFile(path) as Record<string, unknown>;
    const root = doc?.[adapter.rootKey!];
    map = adapter.nestedKey && isPlainObject(root) ? (root as Record<string, unknown>)[adapter.nestedKey] : root;
  }
  if (isPlainObject(map)) for (const [k, v] of Object.entries(map)) out.set(k, v);
  return out;
}

function hubServerDoc(hub: string, name: string): Record<string, unknown> | null {
  const p = join(hub, "mcp", name, "mcp.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null;
}

function writeHubServer(hub: string, name: string, doc: unknown): string {
  const dir = join(hub, "mcp", name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "mcp.json");
  atomicWriteDurable(p, `${JSON.stringify(doc, null, 2)}\n`, 0o644);
  return p;
}

/** Plaintext findings in a hub document (base, each override and its extra). */
function docSecrets(doc: { mcp: Record<string, unknown>; overrides?: Record<string, unknown> }): string[] {
  const fields = detectPlaintextSecrets(doc.mcp as McpServerSpec).map((w) => `mcp.${w.field}`);
  for (const [agent, ov] of Object.entries(doc.overrides ?? {})) {
    for (const w of detectPlaintextSecrets(ov as McpServerSpec)) fields.push(`overrides.${agent}.${w.field}`);
  }
  return fields;
}

/** A stable digest of a directory tree: relative paths, file bytes and modes. */
function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      h.update(`${relative(dir, p)}\0${st.mode & 0o777}\0`);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) h.update(`link\0`);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

function chooseAgents(from?: AgentId): AgentId[] {
  return from ? [from] : [...ALL_AGENTS];
}

/** A sync with --adopt after writing, so the agents' identical entries become owned. */
function adoptAfter(opts: ImportOptions, emit: ReturnType<typeof recorder>["emit"]): number {
  const res = runSync({
    hubDir: opts.hubDir,
    homeDir: opts.homeDir,
    xdgConfigHome: opts.xdgConfigHome,
    xdgStateHome: opts.xdgStateHome,
    adopt: true,
  } as SyncOptions);
  // The sync's own lines, except its terminal one: this run ends with its own summary.
  for (const e of res.events) {
    if (e.id === "agent_hub.summary") continue;
    emit(e.stream, e.id, e.message, e.data);
  }
  return res.exitCode;
}

export function runImport(opts: ImportOptions): Run {
  const r = recorder(opts.onEvent);
  const home = opts.homeDir ?? homedir();
  const configBase = xdgConfigBase(home, opts.xdgConfigHome);
  const hub = canonicalizeHubPath(opts.hubDir, home, process.cwd());
  const phase = opts.apply ? "sync" : "plan";
  const writes: Array<() => void> = [];
  let refusals = 0;
  let planned = 0;
  const rewrittenVars = new Set<string>();

  if (!existsSync(hub)) {
    r.emit("stderr", "agent_hub.error", `sync-agents: canonical hub directory not found: ${hub}`, { code: "hub_not_found" });
    return { exitCode: 1, events: r.events };
  }

  // ---- MCP servers ----
  if (!opts.only || opts.only === "mcp") {
    const installed = new Set<AgentId>();
    const native = new Map<AgentId, Map<string, unknown>>();
    for (const agent of ALL_AGENTS) {
      let m: Map<string, unknown> | null;
      try {
        m = readNativeMcp(agent, home, configBase);
      } catch (err) {
        r.conflict(`cannot read ${agent}'s MCP config: ${err instanceof Error ? err.message : String(err)}`, "fix the file, or import --from another agent");
        refusals++;
        continue;
      }
      if (m === null) continue;
      installed.add(agent);
      if (!chooseAgents(opts.from).includes(agent)) continue;
      // Servers already in the hub are synced, not imported.
      for (const name of [...m.keys()]) if (existsSync(join(hub, "mcp", name))) m.delete(name);
      if (m.size > 0) native.set(agent, m);
    }
    const agg = aggregateServers(native, installed);
    for (const ref of agg.refused) {
      r.conflict(`mcp server "${ref.server}" from ${ref.agent} cannot be imported: ${ref.reason}`, "edit the entry, or exclude that agent with --from");
      refusals++;
    }
    for (const [name, doc0] of agg.servers) {
      let doc = doc0 as { mcp: Record<string, unknown>; overrides?: Record<string, unknown> };
      const secrets = docSecrets(doc);
      if (secrets.length > 0) {
        if (!opts.rewriteSecrets) {
          for (const f of secrets) {
            r.conflict(`mcp server "${name}": ${f} holds a literal that looks like a credential; it would be copied into the hub`, "pass --rewrite-secrets to replace it with ${env:NAME}, or edit the agent's entry first");
            refusals++;
          }
          continue;
        }
        const rw = rewritePlaintextSecrets(name, doc);
        doc = rw.doc;
        for (const x of rw.rewritten) {
          rewrittenVars.add(x.variable);
          r.op(phase, {
            domain: "mcp",
            action: "import-rewrite-secret",
            status: "change",
            destination: `${join(hub, "mcp", name, "mcp.json")}#${x.where}.${x.field}`,
            observed: `${x.where}.${x.field} holds a literal that looks like a credential`,
            intended: `write it as \${env:${x.variable}}`,
            ownershipBasis: "none",
            reason: "a secret must not be copied into the hub",
            nextStep: `set ${x.variable} in the environment of each agent that runs "${name}"`,
            targetMutation: false,
            ledgerMutation: false,
          }, `[${phase}] import-rewrite-secret mcp/${name} ${x.where}.${x.field} -> \${env:${x.variable}}`);
        }
      }
      planned++;
      const dest = join(hub, "mcp", name, "mcp.json");
      r.op(phase, {
        domain: "mcp",
        action: "import-server",
        status: "change",
        destination: dest,
        observed: `server "${name}" in ${[...native.entries()].filter(([, m]) => m.has(name)).map(([a]) => a).join(", ")}`,
        intended: `create ${relative(hub, dest)}`,
        ownershipBasis: "none",
        reason: "the round trip reproduces every agent's entry",
        targetMutation: false,
        ledgerMutation: false,
      }, `[${phase}] import-server mcp/${name}`);
      writes.push(() => void writeHubServer(hub, name, doc));
    }
  }

  // ---- Rules (AGENTS.md) ----
  if (!opts.only || opts.only === "rules") {
    const hubRules = join(hub, "AGENTS.md");
    if (!existsSync(hubRules)) {
      const found = new Map<string, string[]>();
      for (const t of LINK_TARGETS) {
        if (!chooseAgents(opts.from).includes(t.targetId as AgentId) || !t.rulesRel) continue;
        const p = join(linkTargetRoot(t, home, configBase), t.rulesRel);
        if (!existsSync(p) || lstatSync(p).isSymbolicLink() || !statSync(p).isFile()) continue;
        const text = readFileSync(p, "utf8");
        found.set(text, [...(found.get(text) ?? []), p]);
      }
      if (found.size > 1) {
        r.conflict(`the agents' rules files differ (${[...found.values()].flat().join(", ")}); not importing rules`, "make them identical, or import --from one agent");
        refusals++;
      } else if (found.size === 1) {
        const [[text, paths]] = [...found.entries()] as [[string, string[]]];
        planned++;
        r.op(phase, {
          domain: "rules",
          action: "import-rules",
          status: "change",
          destination: hubRules,
          observed: `rules in ${paths.join(", ")}`,
          intended: "create the hub AGENTS.md from them",
          ownershipBasis: "none",
          reason: "the hub has no AGENTS.md",
          targetMutation: false,
          ledgerMutation: false,
        }, `[${phase}] import-rules AGENTS.md`);
        writes.push(() => atomicWriteDurable(hubRules, text, 0o644));
      }
    }
  }

  // ---- Skills ----
  const skillSources: string[] = [];
  if (!opts.only || opts.only === "skills") {
    const byName = new Map<string, Array<{ dir: string; digest: string }>>();
    for (const t of LINK_TARGETS) {
      if (!chooseAgents(opts.from).includes(t.targetId as AgentId) || !t.skillsRel) continue;
      const root = join(linkTargetRoot(t, home, configBase), t.skillsRel);
      if (!existsSync(root) || lstatSync(root).isSymbolicLink()) continue;
      for (const name of readdirSync(root).sort()) {
        const dir = join(root, name);
        if (lstatSync(dir).isSymbolicLink() || !statSync(dir).isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
        if (existsSync(join(hub, "skills", name))) continue;
        byName.set(name, [...(byName.get(name) ?? []), { dir, digest: treeDigest(dir) }]);
      }
    }
    for (const [name, copies] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (new Set(copies.map((c) => c.digest)).size > 1) {
        r.conflict(`skill "${name}" differs between ${copies.map((c) => c.dir).join(", ")}; not importing it`, "make the copies identical, or import --from one agent");
        refusals++;
        continue;
      }
      planned++;
      r.op(phase, {
        domain: "skill",
        action: "import-skill",
        status: "change",
        destination: join(hub, "skills", name),
        observed: `skill in ${copies.map((c) => c.dir).join(", ")}`,
        intended: `install it into the hub as skills/${name}`,
        ownershipBasis: "none",
        reason: "the hub has no skill by that name",
        targetMutation: false,
        ledgerMutation: false,
      }, `[${phase}] import-skill skills/${name}`);
      skillSources.push(copies[0]!.dir);
    }
  }

  if (refusals > 0) {
    r.emit("stderr", "agent_hub.summary", `sync-agents: ${refusals} item(s) cannot be imported; nothing was written.`, { status: "conflicts", conflicts: refusals });
    return { exitCode: 1, events: r.events };
  }
  if (!opts.apply) {
    r.emit("stdout", "agent_hub.summary", planned === 0 ? "sync-agents: nothing to import." : `sync-agents: ${planned} item(s) would be imported; nothing was written (pass --apply).`, {
      status: planned === 0 ? "in_sync" : "planned",
      changes: planned,
    });
    return { exitCode: 0, events: r.events };
  }

  for (const w of writes) w();
  if (skillSources.length > 0) {
    const res = runSync({ hubDir: hub, homeDir: home, xdgConfigHome: opts.xdgConfigHome, xdgStateHome: opts.xdgStateHome, skillSources, skillOnly: true } as SyncOptions);
    for (const e of res.events) if (e.id !== "agent_hub.summary") r.emit(e.stream, e.id, e.message, e.data);
    if (res.exitCode !== 0) {
      r.emit("stderr", "agent_hub.error", "sync-agents: installing imported skills failed; see above", { code: "apply" });
      return { exitCode: 1, events: r.events };
    }
  }
  let exit = 0;
  if (opts.adopt) exit = adoptAfter(opts, r.emit);
  if (rewrittenVars.size > 0) {
    r.emit("stdout", "agent_hub.summary", `sync-agents: imported ${planned} item(s); set ${[...rewrittenVars].sort().join(", ")} in your agents' environment, then run sync-agents --force to replace the agents' literal values.`, {
      status: "applied",
      changes: r.applied(),
    });
    return { exitCode: exit, events: r.events };
  }
  if (exit !== 0) {
    r.emit("stderr", "agent_hub.summary", "sync-agents: imported, but adopting the agents' entries found conflicts; see above.", { status: "conflicts", conflicts: 1 });
    return { exitCode: 1, events: r.events };
  }
  r.emit("stdout", "agent_hub.summary", `sync-agents: imported ${planned} item(s).`, { status: "applied", changes: r.applied() });
  return { exitCode: 0, events: r.events };
}

export function runPull(opts: PullOptions): Run {
  const r = recorder(opts.onEvent);
  const home = opts.homeDir ?? homedir();
  const configBase = xdgConfigBase(home, opts.xdgConfigHome);
  const hub = canonicalizeHubPath(opts.hubDir, home, process.cwd());
  const phase = opts.apply ? "sync" : "plan";
  const { kind, name } = opts.item;
  const fail = (reason: string, next?: string): Run => {
    r.conflict(reason, next);
    r.emit("stderr", "agent_hub.summary", "sync-agents: nothing was pulled.", { status: "conflicts", conflicts: 1 });
    return { exitCode: 1, events: r.events };
  };

  let write: () => void;
  let dest: string;
  if (kind === "mcp") {
    const native = readNativeMcp(opts.from, home, configBase);
    if (native === null) return fail(`${opts.from} is not installed here`);
    const raw = native.get(name);
    if (raw === undefined) return fail(`${opts.from} has no MCP server "${name}"`);
    let d;
    try {
      d = decompileEntry(opts.from, raw, `${opts.from} mcp server "${name}"`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const diff = roundTripDiff(opts.from, raw, d);
    if (diff.length > 0) return fail(`${opts.from} mcp server "${name}" is not lossless: ${diff.join("; ")}`, "edit the entry so the canonical form can carry it");
    const existing = hubServerDoc(hub, name);
    let doc: { mcp: Record<string, unknown>; overrides?: Record<string, unknown> };
    const extra = Object.keys(d.extra).length > 0 ? { extra: d.extra } : {};
    if (existing === null) {
      doc = { mcp: orderedSpec(d.spec), ...(Object.keys(extra).length ? { overrides: { [opts.from]: extra } } : {}) };
    } else {
      const base = parseSpecSnippet(existing, join(hub, "mcp", name, "mcp.json"));
      const ovIn = isPlainObject(existing.overrides) ? (existing.overrides as Record<string, unknown>)[opts.from] : undefined;
      const current = ovIn === undefined ? base : mergeSpec(base, parseSpecSnippet({ mcp: ovIn }, "overrides", true), "overrides");
      const { extra: _e, ...currentPortable } = current;
      if (stableJson(orderedSpec(currentPortable)) === stableJson(orderedSpec(d.spec))) {
        r.emit("stdout", "agent_hub.summary", `sync-agents: mcp/${name} already matches ${opts.from}; nothing to pull.`, { status: "in_sync", changes: 0 });
        return { exitCode: 0, events: r.events };
      }
      if (!opts.asOverride) return fail(`mcp/${name} is already in the hub and differs from ${opts.from}'s entry`, "pass --as-override to record the difference for this agent only");
      const ov = minimalOverride(base, d.spec);
      if (ov === null) return fail(`${opts.from}'s mcp/${name} cannot be expressed as an override of the hub's`);
      const overrides = { ...((existing.overrides as Record<string, unknown>) ?? {}), [opts.from]: { ...orderedSpec(ov), ...extra } };
      doc = { ...(existing as { mcp: Record<string, unknown> }), overrides };
    }
    const secrets = docSecrets(doc);
    if (secrets.length > 0) {
      if (!opts.rewriteSecrets) {
        return fail(`mcp/${name}: ${secrets.join(", ")} hold literals that look like credentials`, "pass --rewrite-secrets to replace them with ${env:NAME}");
      }
      const rw = rewritePlaintextSecrets(name, doc);
      doc = rw.doc;
      for (const x of rw.rewritten) r.emit("stdout", "agent_hub.op", `[${phase}] import-rewrite-secret mcp/${name} ${x.where}.${x.field} -> \${env:${x.variable}}`, {
        phase,
        op: { domain: "mcp", action: "import-rewrite-secret", status: "change", destination: `${join(hub, "mcp", name, "mcp.json")}#${x.where}.${x.field}`, observed: "a literal that looks like a credential", intended: `\${env:${x.variable}}`, ownership_basis: "none", reason: "a secret must not be copied into the hub", target_mutation: false, ledger_mutation: false },
      });
    }
    dest = join(hub, "mcp", name, "mcp.json");
    write = () => void writeHubServer(hub, name, doc);
  } else {
    const t = LINK_TARGETS.find((x) => x.targetId === opts.from && x.skillsRel);
    if (!t) return fail(`${opts.from} has no skills directory`);
    const dir = join(linkTargetRoot(t, home, configBase), t.skillsRel!, name);
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !existsSync(join(dir, "SKILL.md"))) {
      return fail(`${opts.from} has no skill directory "${name}" of its own`);
    }
    dest = join(hub, "skills", name);
    if (existsSync(dest)) {
      if (treeDigest(dest) === treeDigest(dir)) {
        r.emit("stdout", "agent_hub.summary", `sync-agents: skills/${name} already matches ${opts.from}; nothing to pull.`, { status: "in_sync", changes: 0 });
        return { exitCode: 0, events: r.events };
      }
      return fail(`skills/${name} is already in the hub and differs from ${opts.from}'s copy`);
    }
    write = () => {
      const res = runSync({ hubDir: hub, homeDir: home, xdgConfigHome: opts.xdgConfigHome, xdgStateHome: opts.xdgStateHome, skillSources: [dir], skillOnly: true } as SyncOptions);
      for (const e of res.events) if (e.id !== "agent_hub.summary") r.emit(e.stream, e.id, e.message, e.data);
      if (res.exitCode !== 0) throw new Error(`installing skills/${name} failed`);
    };
  }

  r.op(phase, {
    domain: kind === "mcp" ? "mcp" : "skill",
    action: kind === "mcp" ? "pull-server" : "pull-skill",
    status: "change",
    destination: dest,
    observed: `${kind} "${name}" in ${opts.from}`,
    intended: kind === "mcp" ? "write it into the hub, then sync with --adopt" : "install it into the hub, then sync with --adopt",
    ownershipBasis: "none",
    reason: opts.asOverride ? "recorded as an override for this agent" : "the hub does not have it yet",
    targetMutation: false,
    ledgerMutation: false,
  }, `[${phase}] pull-${kind === "mcp" ? "server" : "skill"} ${kind}/${name} from ${opts.from}`);

  if (!opts.apply) {
    r.emit("stdout", "agent_hub.summary", `sync-agents: 1 item would be pulled; nothing was written (pass --apply).`, { status: "planned", changes: 1 });
    return { exitCode: 0, events: r.events };
  }
  try {
    write();
  } catch (err) {
    r.emit("stderr", "agent_hub.error", `sync-agents: ${err instanceof Error ? err.message : String(err)}`, { code: "apply" });
    return { exitCode: 1, events: r.events };
  }
  const exit = adoptAfter(opts as ImportOptions, r.emit);
  if (exit !== 0) {
    r.emit("stderr", "agent_hub.summary", "sync-agents: pulled, but the sync that followed found conflicts; see above.", { status: "conflicts", conflicts: 1 });
    return { exitCode: 1, events: r.events };
  }
  r.emit("stdout", "agent_hub.summary", `sync-agents: pulled ${kind}/${name} from ${opts.from} and synced.`, { status: "applied", changes: r.applied() });
  return { exitCode: 0, events: r.events };
}

export const IMPORT_USAGE = `Usage: sync-agents import [OPTIONS]

Bring agents' existing MCP servers, rules and skills into the hub. Plans by default; writes only
with --apply, and writes nothing if any item is refused.

Options:
      --dir <path>          Hub directory (as for sync-agents)
      --from <agent>        Read only this agent: antigravity, claude, codex, cursor, opencode
      --only <kind>         Import only rules, skills or mcp
      --rewrite-secrets     Replace literals that look like credentials with \${env:NAME}
                            (only the variable names are printed)
  -n, --dry-run             Plan only (the default)
      --apply               Write the hub files
      --adopt               After --apply, sync with --adopt so identical entries become owned
      --human, --humanize   Print prose instead of JSON Lines
  -h, --help                Show this help`;

export const PULL_USAGE = `Usage: sync-agents pull --from <agent> <mcp/<name>|skill/<name>> [OPTIONS]

Copy one MCP server or skill from an agent into the hub, then (with --apply) sync with --adopt,
so sync-agents --check is clean afterwards. Plans by default.

Options:
      --dir <path>          Hub directory (as for sync-agents)
      --from <agent>        The agent to read (required)
      --as-override         When the hub already has the server, record this agent's
                            difference as overrides.<agent>
      --rewrite-secrets     Replace literals that look like credentials with \${env:NAME}
  -n, --dry-run             Plan only (the default)
      --apply               Write and sync
      --human, --humanize   Print prose instead of JSON Lines
  -h, --help                Show this help`;

export type ParsedSubcommand =
  | { kind: "help"; usage: string; command: string }
  | { kind: "import"; opts: Omit<ImportOptions, "hubDir"> & { hubDir?: string } }
  | { kind: "pull"; opts: Omit<PullOptions, "hubDir"> & { hubDir?: string } };

/** Parse `import` / `pull` arguments; throws an Error with a usage message on bad input. */
export function parseSubcommand(cmd: "import" | "pull", argv: string[]): ParsedSubcommand {
  const usage = cmd === "import" ? IMPORT_USAGE : PULL_USAGE;
  const o: Record<string, unknown> = {};
  let item: string | undefined;
  const agentArg = (v: string | undefined): AgentId => {
    if (!v || !ALL_AGENTS.includes(v as AgentId)) {
      throw new Error(`--from needs one of ${ALL_AGENTS.join(", ")}${v ? ` (got "${v}")` : ""}`);
    }
    return v as AgentId;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === "-h" || a === "--help") return { kind: "help", usage, command: `sync-agents ${cmd}` };
    else if (a === "--human" || a === "--humanize") continue;
    else if (a === "--dir") o.hubDir = value();
    else if (a.startsWith("--dir=")) o.hubDir = a.slice(6);
    else if (a === "--from") o.from = agentArg(value());
    else if (a.startsWith("--from=")) o.from = agentArg(a.slice(7));
    else if (a === "--rewrite-secrets") o.rewriteSecrets = true;
    else if (a === "-n" || a === "--dry-run") o.apply = false;
    else if (a === "--apply") o.apply = true;
    else if (cmd === "import" && a === "--adopt") o.adopt = true;
    else if (cmd === "import" && (a === "--only" || a.startsWith("--only="))) {
      const v = a === "--only" ? value() : a.slice(7);
      if (v !== "rules" && v !== "skills" && v !== "mcp") throw new Error(`--only needs rules, skills or mcp (got "${v}")`);
      o.only = v;
    } else if (cmd === "pull" && a === "--as-override") o.asOverride = true;
    else if (cmd === "pull" && !a.startsWith("-") && item === undefined) item = a;
    else throw new Error(`unknown ${cmd} option: ${a}`);
  }
  if (o.apply && argv.includes("--dry-run")) throw new Error("--apply cannot be combined with --dry-run");
  if (cmd === "import") return { kind: "import", opts: o as Omit<ImportOptions, "hubDir"> & { hubDir?: string } };
  if (!o.from) throw new Error("pull needs --from <agent>");
  const m = /^(mcp|skill)\/([A-Za-z0-9._-]+)$/.exec(item ?? "");
  if (!m) throw new Error(`pull needs one item: mcp/<name> or skill/<name>${item ? ` (got "${item}")` : ""}`);
  return { kind: "pull", opts: { ...(o as object), from: o.from as AgentId, item: { kind: m[1] as "mcp" | "skill", name: m[2]! } } };
}
