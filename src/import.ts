/**
 * Phase 3 import (flyingrobots/agent-hub#7): turn agents' native MCP entries into canonical hub
 * specs. An entry is adopted only when it survives the round trip: compiling the decompiled spec
 * (plus its `extra` native fields) must give back an entry equal to the original. Nothing here
 * writes files; callers do, after the gates pass.
 */
import { applyExtra, MCP_ADAPTER_BY_ID, managedKeys } from "./adapters.ts";
import { ENV_NAME, detectPlaintextSecrets, rewriteEnvRefs, specFields } from "./env-refs.ts";
import { mergeSpec } from "./mcp.ts";
import { renderCodexSection } from "./toml-edit.ts";
import { isPlainObject, stableJson } from "./paths.ts";
import { ALL_AGENTS, type AgentId, type McpServerSpec, type McpTransport } from "./types.ts";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export type Decompiled = { transport: McpTransport; spec: McpServerSpec; extra: Record<string, unknown> };

export { managedKeys };

/** Compile a spec for one agent and add its `extra` native fields, refusing managed names. */
export function compileWithExtra(
  agent: AgentId,
  transport: McpTransport,
  spec: McpServerSpec,
  extra: Record<string, unknown> = {},
  serverName = "server",
  sourceLabel = "import",
): Record<string, unknown> {
  return applyExtra(agent, transport, MCP_ADAPTER_BY_ID[agent].compile(transport, spec, serverName, sourceLabel), extra, sourceLabel);
}

const str = (v: unknown, where: string): string => {
  if (typeof v !== "string") throw new ImportError(`${where} must be a string to be imported`);
  return v;
};
const strArray = (v: unknown, where: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ImportError(`${where} must be an array of strings to be imported`);
  }
  return v as string[];
};
const strRecord = (v: unknown, where: string): Record<string, string> => {
  if (!isPlainObject(v) || !Object.values(v).every((x) => typeof x === "string")) {
    throw new ImportError(`${where} must be an object of strings to be imported`);
  }
  return v as Record<string, string>;
};

/**
 * Convert an agent's native reference syntax to `${env:NAME}`, refusing agent-specific forms the
 * canonical spec cannot carry portably (they would reach other agents as literal text, or be
 * expanded by one that reads them differently).
 */
function fromNative(agent: AgentId, value: string, where: string): string {
  if (agent === "claude") {
    const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      if (!ENV_NAME.test(name)) throw new ImportError(`${where}: a \${...} reference whose name is not a portable variable name`);
      return `\${env:${name}}`;
    });
    if (/\$\{(?!env:)/.test(out)) throw new ImportError(`${where}: Claude-specific \${...} syntax cannot be imported`);
    if (out.includes("{env:") && !/\$\{env:/.test(out)) throw new ImportError(`${where}: literal {env:...} text cannot be imported`);
    return out;
  }
  if (agent === "opencode") {
    if (value.includes("${")) throw new ImportError(`${where}: literal \${...} text in an OpenCode entry cannot be imported`);
    return value.replace(/\{env:([^}]*)\}/g, (_m, name: string) => {
      if (!ENV_NAME.test(name)) throw new ImportError(`${where}: an {env:...} reference whose name is not a portable variable name`);
      return `\${env:${name}}`;
    });
  }
  // Cursor uses ${env:NAME} itself; Codex and Antigravity expand nothing.
  if (agent === "cursor") {
    if (/\$\{(?!env:)/.test(value)) throw new ImportError(`${where}: Cursor-specific \${...} variables cannot be imported`);
  } else if (value.includes("${")) {
    throw new ImportError(`${where}: literal \${...} text in a ${agent} entry cannot be imported`);
  }
  if (value.includes("{env:") && !value.includes("${env:")) {
    throw new ImportError(`${where}: literal {env:...} text cannot be imported (OpenCode would expand it)`);
  }
  return value;
}

/** Read one native entry back into a canonical spec plus the native fields it does not model. */
export function decompileEntry(agent: AgentId, raw: unknown, where = `${agent} entry`): Decompiled {
  if (!isPlainObject(raw)) throw new ImportError(`${where} must be an object`);
  const e = raw as Record<string, unknown>;
  const conv = (v: string, w: string) => fromNative(agent, v, w);
  const convAll = (r: Record<string, string>, w: string) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, conv(v, `${w}.${k}`)]));
  let transport: McpTransport;
  const spec: McpServerSpec = {};
  let consumed: string[];

  switch (agent) {
    case "claude": {
      const t = e.type ?? (e.command !== undefined ? "stdio" : undefined);
      if (t === "stdio") {
        transport = "stdio";
        spec.command = conv(str(e.command, `${where}.command`), `${where}.command`);
        const args = e.args === undefined ? [] : strArray(e.args, `${where}.args`);
        if (args.length > 0) spec.args = args.map((a, i) => conv(a, `${where}.args[${i}]`));
        if (e.env !== undefined) spec.env = convAll(strRecord(e.env, `${where}.env`), `${where}.env`);
      } else if (t === "http" || t === "sse") {
        transport = t;
        spec.url = conv(str(e.url, `${where}.url`), `${where}.url`);
        if (e.headers !== undefined) spec.headers = convAll(strRecord(e.headers, `${where}.headers`), `${where}.headers`);
      } else {
        throw new ImportError(`${where}: unsupported type ${JSON.stringify(e.type)}`);
      }
      break;
    }
    case "cursor": {
      if (e.command !== undefined) {
        transport = "stdio";
        if (e.type !== undefined && e.type !== "stdio") throw new ImportError(`${where}: unsupported type ${JSON.stringify(e.type)}`);
        spec.command = conv(str(e.command, `${where}.command`), `${where}.command`);
        if (e.args !== undefined) {
          const args = strArray(e.args, `${where}.args`);
          if (args.length > 0) spec.args = args.map((a, i) => conv(a, `${where}.args[${i}]`));
        }
        if (e.env !== undefined) spec.env = convAll(strRecord(e.env, `${where}.env`), `${where}.env`);
      } else {
        // Cursor's remote entries carry no transport; streamable HTTP is the canonical default.
        transport = "http";
        spec.url = conv(str(e.url, `${where}.url`), `${where}.url`);
        if (e.headers !== undefined) spec.headers = convAll(strRecord(e.headers, `${where}.headers`), `${where}.headers`);
      }
      break;
    }
    case "codex": {
      if (e.command !== undefined) {
        transport = "stdio";
        spec.command = conv(str(e.command, `${where}.command`), `${where}.command`);
        if (e.args !== undefined) {
          const args = strArray(e.args, `${where}.args`);
          if (args.length > 0) spec.args = args.map((a, i) => conv(a, `${where}.args[${i}]`));
        }
        const env: Record<string, string> = e.env === undefined ? {} : convAll(strRecord(e.env, `${where}.env`), `${where}.env`);
        if (e.env_vars !== undefined) {
          for (const name of strArray(e.env_vars, `${where}.env_vars`)) {
            if (!ENV_NAME.test(name)) throw new ImportError(`${where}.env_vars: an entry is not a portable variable name (it should name a variable, not hold its value)`);
            if (name in env) throw new ImportError(`${where}: ${name} is both in env and env_vars`);
            env[name] = `\${env:${name}}`;
          }
        }
        if (Object.keys(env).length > 0) spec.env = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
      } else {
        transport = "http";
        spec.url = conv(str(e.url, `${where}.url`), `${where}.url`);
        const headers: Record<string, string> =
          e.http_headers === undefined ? {} : convAll(strRecord(e.http_headers, `${where}.http_headers`), `${where}.http_headers`);
        if (e.bearer_token_env_var !== undefined) {
          const name = str(e.bearer_token_env_var, `${where}.bearer_token_env_var`);
          if (!ENV_NAME.test(name)) throw new ImportError(`${where}.bearer_token_env_var is not a portable variable name (it should name a variable, not hold its value)`);
          if (Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
            throw new ImportError(`${where}: both bearer_token_env_var and an Authorization header`);
          }
          headers.Authorization = `Bearer \${env:${name}}`;
        }
        if (e.env_http_headers !== undefined) {
          for (const [h, name] of Object.entries(strRecord(e.env_http_headers, `${where}.env_http_headers`))) {
            if (!ENV_NAME.test(name)) throw new ImportError(`${where}.env_http_headers.${h} is not a portable variable name (it should name a variable, not hold its value)`);
            if (h in headers) throw new ImportError(`${where}: header ${h} is set twice`);
            headers[h] = `\${env:${name}}`;
          }
        }
        if (Object.keys(headers).length > 0) spec.headers = headers;
      }
      break;
    }
    case "opencode": {
      if (e.type === "local") {
        transport = "stdio";
        const cmd = strArray(e.command, `${where}.command`);
        if (cmd.length === 0) throw new ImportError(`${where}.command must not be empty`);
        spec.command = conv(cmd[0]!, `${where}.command[0]`);
        if (cmd.length > 1) spec.args = cmd.slice(1).map((a, i) => conv(a, `${where}.command[${i + 1}]`));
        if (e.environment !== undefined) spec.env = convAll(strRecord(e.environment, `${where}.environment`), `${where}.environment`);
      } else if (e.type === "remote") {
        transport = "http";
        spec.url = conv(str(e.url, `${where}.url`), `${where}.url`);
        if (e.headers !== undefined) spec.headers = convAll(strRecord(e.headers, `${where}.headers`), `${where}.headers`);
      } else {
        throw new ImportError(`${where}: unsupported type ${JSON.stringify(e.type)}`);
      }
      break;
    }
    case "antigravity": {
      if (e.command !== undefined) {
        transport = "stdio";
        spec.command = conv(str(e.command, `${where}.command`), `${where}.command`);
        if (e.args !== undefined) {
          const args = strArray(e.args, `${where}.args`);
          if (args.length > 0) spec.args = args.map((a, i) => conv(a, `${where}.args[${i}]`));
        }
        if (e.env !== undefined) spec.env = convAll(strRecord(e.env, `${where}.env`), `${where}.env`);
      } else {
        transport = "http";
        spec.url = conv(str(e.serverUrl, `${where}.serverUrl`), `${where}.serverUrl`);
        if (e.headers !== undefined) spec.headers = convAll(strRecord(e.headers, `${where}.headers`), `${where}.headers`);
      }
      break;
    }
  }
  // An empty map carries nothing; every adapter's comparable form drops it too.
  if (spec.env && Object.keys(spec.env).length === 0) delete spec.env;
  if (spec.headers && Object.keys(spec.headers).length === 0) delete spec.headers;
  consumed = managedKeys(agent, transport!);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!consumed.includes(k)) extra[k] = v;
  if (transport! !== "stdio") spec.transport = transport!;
  return { transport: transport!, spec, extra };
}

/** Paths whose values differ between compile(decompile(raw)) and raw; empty when lossless. */
export function roundTripDiff(agent: AgentId, raw: unknown, d: Decompiled): string[] {
  const adapter = MCP_ADAPTER_BY_ID[agent];
  let compiled: Record<string, unknown>;
  try {
    compiled = compileWithExtra(agent, d.transport, d.spec, d.extra);
  } catch (err) {
    return [`compile: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (agent === "codex") {
    // An entry the TOML editor cannot write back (nested tables in extra) is not lossless.
    try {
      renderCodexSection("server", compiled);
    } catch (err) {
      return [`config.toml: cannot be written back (${err instanceof Error ? err.message : String(err)})`];
    }
  }
  const a = adapter.normalizeComparable(compiled);
  const b = adapter.normalizeComparable(raw);
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (stableJson(x) === stableJson(y)) return;
    if (isPlainObject(x) && isPlainObject(y)) {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    // Values are not printed: they may be secrets.
    diffs.push(`${path || "entry"}: ${y === undefined ? "would be added" : x === undefined ? "would be lost" : "would change"}`);
  };
  walk(a, b, "");
  return diffs;
}

type ServerDoc = { mcp: Record<string, unknown>; overrides?: Record<string, Record<string, unknown>> };

/** The canonical spec as a hub mcp.json `mcp` object, keys in a fixed order. */
export function orderedSpec(spec: McpServerSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sortRec = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  if (spec.transport !== undefined) out.transport = spec.transport;
  if (spec.command !== undefined) out.command = spec.command;
  if (spec.args !== undefined) out.args = spec.args;
  if (spec.env !== undefined) out.env = sortRec(spec.env);
  if (spec.url !== undefined) out.url = spec.url;
  if (spec.headers !== undefined) out.headers = sortRec(spec.headers);
  if (spec.disabled !== undefined) out.disabled = spec.disabled;
  return out;
}

/** The smallest override that, layered on base with mergeSpec, gives spec; null when none does. */
export function minimalOverride(base: McpServerSpec, spec: McpServerSpec): McpServerSpec | null {
  const ov: McpServerSpec = {};
  for (const k of ["transport", "command", "args", "url"] as const) {
    if (stableJson(base[k]) !== stableJson(spec[k])) (ov as Record<string, unknown>)[k] = spec[k];
  }
  for (const k of ["env", "headers"] as const) {
    const b = base[k] ?? {};
    const s = spec[k] ?? {};
    const changed = Object.fromEntries(Object.entries(s).filter(([n, v]) => b[n] !== v));
    if (Object.keys(changed).length > 0) ov[k] = changed;
  }
  let merged: McpServerSpec;
  try {
    merged = mergeSpec(base, ov, "import");
  } catch {
    return null;
  }
  const norm = (s: McpServerSpec) => stableJson(orderedSpec({ ...s, ...(s.transport === "stdio" ? { transport: undefined } : {}) }));
  return norm(merged) === norm(spec) ? ov : null;
}

export type AggregateResult = {
  servers: Map<string, ServerDoc>;
  refused: Array<{ server: string; agent: AgentId; reason: string }>;
};

/**
 * Turn every agent's native entries into hub documents. Identical specs across agents become
 * the base (the largest group; ties go to the group holding the earliest agent in target
 * order); each other agent gets the smallest override reproducing its spec, plus its `extra`.
 * Installed agents without the server get `disabled: true`, so a later sync adds nothing. A
 * server is refused whole when any agent's entry fails the round trip or cannot be expressed.
 */
export function aggregateServers(
  native: ReadonlyMap<AgentId, ReadonlyMap<string, unknown>>,
  installed: ReadonlySet<AgentId>,
): AggregateResult {
  const servers = new Map<string, ServerDoc>();
  const refused: AggregateResult["refused"] = [];
  const names = [...new Set([...native.values()].flatMap((m) => [...m.keys()]))].sort();
  for (const name of names) {
    const per = new Map<AgentId, Decompiled>();
    let failed = false;
    for (const agent of ALL_AGENTS) {
      const raw = native.get(agent)?.get(name);
      if (raw === undefined) continue;
      try {
        const d = decompileEntry(agent, raw, `${agent} mcp server "${name}"`);
        const diff = roundTripDiff(agent, raw, d);
        if (diff.length > 0) {
          refused.push({ server: name, agent, reason: `not lossless: ${diff.join("; ")}` });
          failed = true;
          break;
        }
        per.set(agent, d);
      } catch (err) {
        refused.push({ server: name, agent, reason: err instanceof Error ? err.message : String(err) });
        failed = true;
        break;
      }
    }
    if (failed) continue;
    const groups = new Map<string, AgentId[]>();
    for (const [agent, d] of per) {
      const key = stableJson(orderedSpec(d.spec));
      groups.set(key, [...(groups.get(key) ?? []), agent]);
    }
    const order = (a: AgentId) => ALL_AGENTS.indexOf(a);
    const [baseKey] = [...groups.entries()].sort(
      ([, a], [, b]) => b.length - a.length || order(a[0]!) - order(b[0]!),
    )[0]!;
    const baseAgent = groups.get(baseKey)![0]!;
    const base = per.get(baseAgent)!.spec;
    const overrides: Record<string, Record<string, unknown>> = {};
    let inexpressible: AgentId | null = null;
    for (const agent of ALL_AGENTS) {
      const d = per.get(agent);
      if (!d) {
        if (installed.has(agent)) overrides[agent] = { disabled: true };
        continue;
      }
      const ov: Record<string, unknown> = {};
      if (stableJson(orderedSpec(d.spec)) !== baseKey) {
        const m = minimalOverride(base, d.spec);
        if (m === null) {
          inexpressible = agent;
          break;
        }
        Object.assign(ov, orderedSpec(m));
      }
      if (Object.keys(d.extra).length > 0) ov.extra = Object.fromEntries(Object.entries(d.extra).sort(([a], [b]) => a.localeCompare(b)));
      if (Object.keys(ov).length > 0) overrides[agent] = ov;
    }
    if (inexpressible) {
      refused.push({
        server: name,
        agent: inexpressible,
        reason: `its spec cannot be expressed as an override of ${baseAgent}'s (an override cannot remove an env key or header); import it on its own with --from ${inexpressible}`,
      });
      continue;
    }
    const doc: ServerDoc = { mcp: orderedSpec(base) };
    if (Object.keys(overrides).length > 0) doc.overrides = overrides;
    servers.set(name, doc);
  }
  return { servers, refused };
}

/** A variable name for a field: env keys keep their name, other fields get SERVER_FIELD. */
function suggestedVariable(server: string, field: string): string {
  const clean = (s: string) => {
    const up = s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    return /^[0-9]/.test(up) ? `_${up}` : up;
  };
  if (field.startsWith("env.")) return clean(field.slice(4));
  if (/^headers\.authorization$/i.test(field)) return `${clean(server)}_TOKEN`;
  if (field.startsWith("headers.")) return `${clean(server)}_${clean(field.slice(8))}`;
  return `${clean(server)}_${clean(field)}`;
}

function rewriteField(spec: McpServerSpec, field: string, variable: string): void {
  const ref = `\${env:${variable}}`;
  if (field === "command") spec.command = ref;
  else if (field === "url") spec.url = ref;
  else if (field.startsWith("args[")) spec.args![Number(field.slice(5, -1))] = ref;
  else if (field.startsWith("env.")) spec.env![field.slice(4)] = ref;
  else if (field.startsWith("headers.")) {
    const h = field.slice(8);
    const v = spec.headers![h]!;
    // Keep the scheme, so `Bearer ${env:X}` stays expressible for Codex.
    const scheme = /^(Bearer|Basic|Token)\s+/i.exec(v);
    spec.headers![h] = scheme ? `${scheme[1]} ${ref}` : ref;
  }
}

/**
 * Replace each literal the plaintext detector flags with `${env:NAME}`. Returns the rewritten
 * document and, per field, only the variable name: never the value.
 */
export function rewritePlaintextSecrets(
  server: string,
  doc: { mcp: Record<string, unknown>; overrides?: Record<string, unknown> },
): { doc: { mcp: Record<string, unknown>; overrides?: Record<string, unknown> }; rewritten: Array<{ server: string; where: string; field: string; variable: string }> } {
  const rewritten: Array<{ server: string; where: string; field: string; variable: string }> = [];
  const fix = (snippet: Record<string, unknown>, where: string): Record<string, unknown> => {
    const spec = structuredClone(snippet) as McpServerSpec;
    for (const w of detectPlaintextSecrets(spec)) {
      const variable = suggestedVariable(server, w.field);
      rewriteField(spec, w.field, variable);
      rewritten.push({ server, where, field: w.field, variable });
    }
    return spec as Record<string, unknown>;
  };
  const out: { mcp: Record<string, unknown>; overrides?: Record<string, unknown> } = { mcp: fix(doc.mcp, "mcp") };
  if (doc.overrides) {
    out.overrides = {};
    for (const [agent, ov] of Object.entries(doc.overrides)) {
      const { extra, ...rest } = ov as Record<string, unknown>;
      if (extra !== undefined) {
        const inExtra = detectPlaintextSecrets({ extra } as McpServerSpec).map((w) => w.field);
        if (inExtra.length > 0) {
          // extra is passed to the agent verbatim, so a reference there would not be expanded.
          throw new ImportError(
            `overrides.${agent}: ${inExtra.join(", ")} hold literals that look like credentials in native fields sync-agents passes through as written; they cannot be rewritten to references. Remove them from the agent's entry, then import again`,
          );
        }
      }
      const fixed = fix(rest, `overrides.${agent}`);
      out.overrides[agent] = extra === undefined ? fixed : { ...fixed, extra };
    }
  }
  return { doc: out, rewritten };
}

/** Field paths of a spec, re-exported for callers that print them. */
export { specFields };
export { rewriteEnvRefs };
