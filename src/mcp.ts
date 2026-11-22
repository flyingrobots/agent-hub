import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  atomicWriteDurable,
  captureFileSnapshot,
  isPlainObject,
  sha256Hex,
  snapshotsEqual,
  stableJson,
} from "./paths.ts";
import {
  applyStateDelta,
  clearJournal,
  saveOwnershipState,
  writeJournal,
} from "./state.ts";
import { normalizeCodexComparable, rewriteCodexToml } from "./toml-edit.ts";
import {
  ALL_AGENTS,
  type AgentId,
  type ApplyHooks,
  type LegacyManifestV1,
  type ManagedMcpRecord,
  type McpServerSpec,
  type McpTransport,
  type OwnershipBasis,
  type OwnershipStateV2,
  type PendingJournalRecord,
  type PlannedOp,
  type RawMcpDocument,
  type StateDelta,
  type TargetSnapshot,
} from "./types.ts";

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type CompiledServerMap = Map<string, Record<AgentId, Record<string, unknown> | null>>;

export type PlannedMcpTarget = {
  agent: AgentId;
  rootDir: string;
  configPath: string;
  ops: PlannedOp[];
  targetMutation: boolean;
  ledgerMutation: boolean;
  beforeSnapshot: TargetSnapshot;
  renderedContent?: string;
  targetMode: number;
  nextAgentMcp: Record<string, ManagedMcpRecord>;
  nextResolvedLegacyV1: string[];
  basis: OwnershipBasis | "managed";
  summaryReason: string;
};

type TransportFamily = "stdio" | "remote" | null;

function detectFamily(spec: McpServerSpec): TransportFamily {
  const hasStdio =
    spec.transport === "stdio" ||
    spec.command !== undefined ||
    spec.args !== undefined ||
    spec.env !== undefined;
  const hasRemote =
    spec.transport === "http" ||
    spec.transport === "sse" ||
    spec.url !== undefined ||
    spec.headers !== undefined;

  if (hasStdio && hasRemote) {
    throw new Error("cannot combine stdio fields (command/args/env) with remote fields (url/headers)");
  }
  if (hasStdio) return "stdio";
  if (hasRemote) return "remote";
  return null;
}

export function parseSpecSnippet(raw: unknown, sourceLabel: string): McpServerSpec {
  if (!isPlainObject(raw)) {
    throw new Error(`${sourceLabel}: expected JSON object`);
  }
  const body = "mcp" in raw ? raw.mcp : raw;
  if (!isPlainObject(body)) {
    throw new Error(`${sourceLabel}: "mcp" field must be an object`);
  }

  const allowedKeys = new Set([
    "transport",
    "command",
    "args",
    "env",
    "url",
    "headers",
    "disabled",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${sourceLabel}: unknown MCP field "${key}"`);
    }
  }

  const spec: McpServerSpec = {};
  if (body.transport !== undefined) {
    if (body.transport !== "stdio" && body.transport !== "http" && body.transport !== "sse") {
      throw new Error(
        `${sourceLabel}: transport must be one of "stdio", "http", or "sse" (got ${JSON.stringify(body.transport)})`,
      );
    }
    spec.transport = body.transport as McpTransport;
  }
  if (body.command !== undefined) {
    if (typeof body.command !== "string" || body.command.length === 0) {
      throw new Error(`${sourceLabel}: command must be a non-empty string`);
    }
    spec.command = body.command;
  }
  if (body.args !== undefined) {
    if (!Array.isArray(body.args) || !body.args.every((a) => typeof a === "string")) {
      throw new Error(`${sourceLabel}: args must be an array of strings`);
    }
    spec.args = [...body.args];
  }
  if (body.env !== undefined) {
    if (!isPlainObject(body.env) || !Object.values(body.env).every((v) => typeof v === "string")) {
      throw new Error(`${sourceLabel}: env must be an object of string values`);
    }
    spec.env = Object.fromEntries(
      Object.entries(body.env as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (body.url !== undefined) {
    if (typeof body.url !== "string" || body.url.length === 0) {
      throw new Error(`${sourceLabel}: url must be a non-empty string`);
    }
    spec.url = body.url;
  }
  if (body.headers !== undefined) {
    if (
      !isPlainObject(body.headers) ||
      !Object.values(body.headers).every((v) => typeof v === "string")
    ) {
      throw new Error(`${sourceLabel}: headers must be an object of string values`);
    }
    spec.headers = Object.fromEntries(
      Object.entries(body.headers as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") {
      throw new Error(`${sourceLabel}: disabled must be a boolean`);
    }
    spec.disabled = body.disabled;
  }

  try {
    detectFamily(spec);
  } catch (err) {
    throw new Error(`${sourceLabel}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return spec;
}

/**
 * Merge a per-agent override onto a base spec with deterministic transport-family switching:
 * - Switching remote -> stdio clears inherited url/headers and sets transport to "stdio".
 * - Switching stdio -> remote clears inherited command/args/env and uses override's transport/url/headers.
 * - Staying within the same family shallow-merges scalars and merges sorted env/headers maps.
 */
export function mergeSpec(
  base: McpServerSpec,
  override: McpServerSpec | undefined,
  sourceLabel: string,
): McpServerSpec {
  if (!override) return { ...base };

  const baseFamily = detectFamily(base);
  const ovFamily = detectFamily(override);

  // Explicit transport-family switch clears opposite-family inherited fields.
  const isFamilySwitch =
    baseFamily !== null &&
    ovFamily !== null &&
    baseFamily !== ovFamily &&
    (ovFamily === "stdio"
      ? override.command !== undefined || override.transport === "stdio"
      : override.url !== undefined ||
        override.transport === "http" ||
        override.transport === "sse");

  if (isFamilySwitch) {
    const switched: McpServerSpec = {};
    if (base.disabled !== undefined) switched.disabled = base.disabled;
    if (override.disabled !== undefined) switched.disabled = override.disabled;
    if (ovFamily === "stdio") {
      switched.transport = "stdio";
      if (override.command !== undefined) switched.command = override.command;
      if (override.args !== undefined) switched.args = [...override.args];
      if (override.env !== undefined) switched.env = { ...override.env };
    } else {
      if (override.transport !== undefined) switched.transport = override.transport;
      if (override.url !== undefined) switched.url = override.url;
      if (override.headers !== undefined) switched.headers = { ...override.headers };
    }
    return switched;
  }

  if (baseFamily !== null && ovFamily !== null && baseFamily !== ovFamily) {
    throw new Error(
      `${sourceLabel}: cannot apply ${ovFamily}-only fields onto a ${baseFamily} base without switching transport (provide "${ovFamily === "stdio" ? "command" : "url"}" / "transport")`,
    );
  }

  const merged: McpServerSpec = {
    ...base,
    ...override,
  };
  if (base.env || override.env) {
    merged.env = Object.fromEntries(
      Object.entries({ ...(base.env ?? {}), ...(override.env ?? {}) }).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  }
  if (base.headers || override.headers) {
    merged.headers = Object.fromEntries(
      Object.entries({ ...(base.headers ?? {}), ...(override.headers ?? {}) }).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  }
  return merged;
}

/**
 * Compile a resolved per-agent spec using disabled-first precedence:
 * 1. If `spec.disabled === true`, omit (`null`) across ALL adapters before validating active transport.
 * 2. Otherwise validate explicit transport and adapter transport capabilities.
 */
export function compileAgentEntry(
  agent: AgentId,
  serverName: string,
  spec: McpServerSpec,
  sourceLabel: string,
): Record<string, unknown> | null {
  // Step 1: Uniform disabled-first precedence across all adapters.
  if (spec.disabled === true) {
    return null;
  }

  // Step 2: Validate resolved active transport.
  if (spec.command && spec.url) {
    throw new Error(`${sourceLabel} (${agent}): cannot specify both "command" and "url"`);
  }

  let transport: McpTransport;
  if (spec.command) {
    if (spec.transport && spec.transport !== "stdio") {
      throw new Error(
        `${sourceLabel} (${agent}): "command" requires transport "stdio" (got "${spec.transport}")`,
      );
    }
    if (spec.headers && Object.keys(spec.headers).length > 0) {
      throw new Error(`${sourceLabel} (${agent}): "headers" is not valid for stdio transport`);
    }
    transport = "stdio";
  } else if (spec.url) {
    if (spec.transport !== "http" && spec.transport !== "sse") {
      throw new Error(
        `${sourceLabel} (${agent}): remote "url" for MCP "${serverName}" must explicitly specify "transport": "http" (streamable HTTP) or "transport": "sse"`,
      );
    }
    if (spec.args && spec.args.length > 0) {
      throw new Error(`${sourceLabel} (${agent}): "args" is not valid for remote transport`);
    }
    if (spec.env && Object.keys(spec.env).length > 0) {
      throw new Error(`${sourceLabel} (${agent}): "env" is not valid for remote transport`);
    }
    transport = spec.transport;
  } else {
    throw new Error(
      `${sourceLabel} (${agent}): enabled MCP "${serverName}" must specify either "command" (stdio) or "url" + "transport" ("http" | "sse")`,
    );
  }

  if (agent === "claude") {
    if (transport === "stdio") {
      const out: Record<string, unknown> = {
        type: "stdio",
        command: spec.command,
        args: spec.args ?? [],
      };
      if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
      return out;
    }
    const out: Record<string, unknown> = {
      type: transport, // "http" or "sse"
      url: spec.url,
    };
    if (spec.headers && Object.keys(spec.headers).length > 0) out.headers = spec.headers;
    return out;
  }

  if (agent === "codex") {
    if (transport === "sse") {
      throw new Error(
        `${sourceLabel}: Codex does not support SSE transport for MCP "${serverName}" (set overrides.codex.disabled = true or override codex to http/stdio)`,
      );
    }
    const out: Record<string, unknown> = {};
    if (transport === "stdio") {
      out.command = spec.command;
      if (spec.args && spec.args.length > 0) out.args = spec.args;
      if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
    } else {
      out.url = spec.url;
      if (spec.headers && Object.keys(spec.headers).length > 0) out.http_headers = spec.headers;
    }
    return out;
  }

  // agent === "antigravity"
  if (transport === "sse") {
    throw new Error(
      `${sourceLabel}: Antigravity does not support SSE transport for MCP "${serverName}" (set overrides.antigravity.disabled = true or override antigravity to http/stdio)`,
    );
  }
  const out: Record<string, unknown> = {};
  if (transport === "stdio") {
    out.command = spec.command;
    if (spec.args && spec.args.length > 0) out.args = spec.args;
    if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
  } else {
    out.serverUrl = spec.url;
    if (spec.headers && Object.keys(spec.headers).length > 0) out.headers = spec.headers;
  }
  out.disabled = false;
  return out;
}

export function loadCanonicalServers(canonicalHubPath: string): CompiledServerMap {
  const result: CompiledServerMap = new Map();
  const mcpRoot = join(canonicalHubPath, "mcp");
  if (!existsSync(mcpRoot)) return result;

  const entries = readdirSync(mcpRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const name = entry.name;
    if (!SERVER_NAME_RE.test(name)) {
      throw new Error(`mcp-sync: invalid MCP server directory name: ${name}`);
    }
    const serverDir = join(mcpRoot, name);
    const basePath = join(serverDir, "mcp.json");
    if (!existsSync(basePath)) continue;

    // Detect legacy "gemini/" override subdirectory explicitly.
    const legacyGeminiSub = join(serverDir, "gemini", "mcp.json");
    if (existsSync(legacyGeminiSub)) {
      throw new Error(
        `${legacyGeminiSub}: "gemini" override was renamed to "antigravity" (Antigravity uses ~/.gemini/config/mcp_config.json; Gemini CLI ~/.gemini/settings.json is not currently supported)`,
      );
    }

    const rawDoc = JSON.parse(readFileSync(basePath, "utf8")) as RawMcpDocument;
    const baseSpec = parseSpecSnippet(rawDoc, basePath);

    if (rawDoc.overrides !== undefined) {
      if (!isPlainObject(rawDoc.overrides)) {
        throw new Error(`${basePath}: "overrides" must be an object`);
      }
      for (const key of Object.keys(rawDoc.overrides)) {
        if (key === "gemini") {
          throw new Error(
            `${basePath}#overrides.gemini: "gemini" override was renamed to "antigravity" (Antigravity uses ~/.gemini/config/mcp_config.json; Gemini CLI ~/.gemini/settings.json is not currently supported)`,
          );
        }
        if (!ALL_AGENTS.includes(key as AgentId)) {
          throw new Error(
            `${basePath}#overrides.${key}: unknown override agent "${key}" (expected one of: ${ALL_AGENTS.join(", ")})`,
          );
        }
      }
    }

    const compiled = {} as Record<AgentId, Record<string, unknown> | null>;

    for (const agent of ALL_AGENTS) {
      let resolved: McpServerSpec = { ...baseSpec };

      if (rawDoc.overrides && rawDoc.overrides[agent] !== undefined) {
        const inlineOv = parseSpecSnippet(
          { mcp: rawDoc.overrides[agent] },
          `${basePath}#overrides.${agent}`,
        );
        resolved = mergeSpec(resolved, inlineOv, `${basePath}#overrides.${agent}`);
      }

      const subPath = join(serverDir, agent, "mcp.json");
      if (existsSync(subPath)) {
        const subRaw = JSON.parse(readFileSync(subPath, "utf8"));
        const subOv = parseSpecSnippet(subRaw, subPath);
        resolved = mergeSpec(resolved, subOv, subPath);
      }

      compiled[agent] = compileAgentEntry(agent, name, resolved, basePath);
    }

    result.set(name, compiled);
  }

  return result;
}

export function normalizeAntigravityComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (typeof copy.url === "string" && copy.serverUrl === undefined) {
    copy.serverUrl = copy.url;
    delete copy.url;
  }
  copy.disabled = Boolean(copy.disabled);
  if (Array.isArray(copy.args) && copy.args.length === 0) delete copy.args;
  if (isPlainObject(copy.env) && Object.keys(copy.env).length === 0) delete copy.env;
  if (isPlainObject(copy.headers) && Object.keys(copy.headers).length === 0) delete copy.headers;
  return copy;
}

export function normalizeClaudeComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (copy.command && !copy.type) copy.type = "stdio";
  if (copy.type === "stdio" && copy.args === undefined) copy.args = [];
  if (isPlainObject(copy.env) && Object.keys(copy.env).length === 0) delete copy.env;
  if (isPlainObject(copy.headers) && Object.keys(copy.headers).length === 0) delete copy.headers;
  return copy;
}

function normalizeComparable(agent: AgentId, entry: unknown): Record<string, unknown> {
  if (agent === "antigravity") return normalizeAntigravityComparable(entry);
  if (agent === "claude") return normalizeClaudeComparable(entry);
  return normalizeCodexComparable(entry);
}

function predictNewFileOwner(parentDir: string): { uid: number; gid: number } {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const procGid = typeof process.getgid === "function" ? process.getgid() : 0;
  try {
    let cursor = parentDir;
    while (!existsSync(cursor)) {
      const next = dirname(cursor);
      if (next === cursor) return { uid, gid: procGid };
      cursor = next;
    }
    const st = statSync(cursor);
    if (process.platform === "darwin" || (st.mode & 0o2000) !== 0) {
      return { uid, gid: st.gid };
    }
  } catch {
    // ignore
  }
  return { uid, gid: procGid };
}

export function planMcpSync(
  canonicalHubPath: string,
  homeDir: string,
  state: OwnershipStateV2,
  legacyV1: LegacyManifestV1 | null,
  opts: {
    adopt: boolean;
    force: boolean;
    disownLegacy: Array<{ agent: AgentId; name: string }>;
  },
): { targets: PlannedMcpTarget[]; globalOps: PlannedOp[] } {
  const globalOps: PlannedOp[] = [];
  const servers = loadCanonicalServers(canonicalHubPath);
  const now = new Date().toISOString();

  // Validate --disown-legacy requests upfront.
  const disownByAgent: Record<AgentId, Set<string>> = {
    antigravity: new Set(),
    claude: new Set(),
    codex: new Set(),
  };
  for (const req of opts.disownLegacy) {
    const inLegacy = legacyV1?.managed[req.agent].has(req.name) ?? false;
    if (!inLegacy) {
      globalOps.push({
        domain: "mcp",
        action: "conflict",
        status: "conflict",
        destination: `${req.agent}:${req.name}`,
        observed: "not an active unverified legacy v1 claim",
        intended: `disown legacy v1 claim ${req.agent}:${req.name}`,
        ownershipBasis: "none",
        reason: `--disown-legacy ${req.agent}:${req.name}: no pending legacy v1 claim found for "${req.name}" on ${req.agent}`,
        nextStep: "Check <hub>/.mcp-managed.json or run sync-agents --explain",
        targetMutation: false,
        ledgerMutation: false,
      });
      continue;
    }
    if (servers.has(req.name)) {
      globalOps.push({
        domain: "mcp",
        action: "conflict",
        status: "conflict",
        destination: `${req.agent}:${req.name}`,
        observed: `canonical <hub>/mcp/${req.name}/mcp.json still declares "${req.name}"`,
        intended: `retain personal "${req.name}" on ${req.agent} without ownership`,
        ownershipBasis: "legacy-v1-unverified",
        reason: `cannot disown legacy claim ${req.agent}:${req.name} while canonical <hub>/mcp/${req.name} still declares "${req.name}"`,
        nextStep: `Withdraw or rename <hub>/mcp/${req.name} first (note: renaming/removing affects all adapters), then re-run --disown-legacy ${req.agent}:${req.name}`,
        targetMutation: false,
        ledgerMutation: false,
      });
      continue;
    }
    disownByAgent[req.agent].add(req.name);
  }

  const targetSpecs: Array<{
    agent: AgentId;
    rootDir: string;
    configPath: string;
    defaultMode: number;
  }> = [
    {
      agent: "antigravity",
      rootDir: join(homeDir, ".gemini", "config"),
      configPath: join(homeDir, ".gemini", "config", "mcp_config.json"),
      defaultMode: 0o644,
    },
    {
      agent: "claude",
      rootDir: join(homeDir, ".claude"),
      configPath: join(homeDir, ".claude.json"),
      defaultMode: 0o600,
    },
    {
      agent: "codex",
      rootDir: join(homeDir, ".codex"),
      configPath: join(homeDir, ".codex", "config.toml"),
      defaultMode: 0o600,
    },
  ];

  const targets: PlannedMcpTarget[] = [];

  for (const spec of targetSpecs) {
    if (!existsSync(spec.rootDir) || !statSync(spec.rootDir).isDirectory()) continue;

    const { agent, rootDir, configPath, defaultMode } = spec;
    const beforeSnapshot = captureFileSnapshot(configPath);
    if (beforeSnapshot.kind !== "absent" && beforeSnapshot.kind !== "file") {
      throw new Error(`mcp-sync: expected regular file at ${configPath}`);
    }
    const targetMode = beforeSnapshot.kind === "file" ? beforeSnapshot.mode : defaultMode;

    const prevManaged = state.mcp[agent];
    const legacySet = legacyV1?.managed[agent] ?? new Set<string>();
    const nextAgentMcp: Record<string, ManagedMcpRecord> = {};
    const nextResolvedLegacySet = new Set<string>(state.resolvedLegacyV1[agent]);

    let originalText = "";
    let jsonDoc: Record<string, unknown> = {};
    let existingMap: Record<string, unknown> = {};

    if (beforeSnapshot.kind === "file") {
      originalText = readFileSync(configPath, "utf8");
      if (agent === "codex") {
        const parsed = originalText.trim()
          ? (Bun.TOML.parse(originalText) as Record<string, unknown>)
          : {};
        existingMap = isPlainObject(parsed.mcp_servers)
          ? { ...(parsed.mcp_servers as Record<string, unknown>) }
          : {};
      } else {
        const parsed = JSON.parse(originalText) as unknown;
        if (!isPlainObject(parsed)) {
          throw new Error(`mcp-sync: ${configPath} must contain a JSON object`);
        }
        jsonDoc = parsed;
        existingMap = isPlainObject(jsonDoc.mcpServers)
          ? { ...(jsonDoc.mcpServers as Record<string, unknown>) }
          : {};
      }
    }

    const codexUpdates = new Map<string, Record<string, unknown> | null>();
    const ops: PlannedOp[] = [];
    let targetMutation = false;
    let ledgerMutation = false;
    let basisUsed: OwnershipBasis | "managed" = "managed";
    const changeSummaries: string[] = [];

    // 1. Evaluate all canonical servers for this agent
    for (const [name, compiledPerAgent] of servers) {
      const desired = compiledPerAgent[agent];
      const hasExisting = Object.prototype.hasOwnProperty.call(existingMap, name);
      const managedRec = Object.prototype.hasOwnProperty.call(prevManaged, name)
        ? prevManaged[name]!
        : undefined;
      const isLegacy = !managedRec && legacySet.has(name);

      const comparableExisting = hasExisting ? normalizeComparable(agent, existingMap[name]) : null;
      const existingDigest = comparableExisting ? sha256Hex(stableJson(comparableExisting)) : null;

      // ---- DISABLED (desired === null) ----
      if (desired === null) {
        if (!hasExisting) {
          if (managedRec) {
            // T-MCP-05: Managed entry already absent -> ledger-only cleanup
            ledgerMutation = true;
            changeSummaries.push(`drop absent MCP record ${name}`);
            ops.push({
              domain: "mcp",
              action: "drop-absent-mcp",
              status: "change",
              destination: `${configPath}#${name}`,
              observed: "absent in target config (stale managed record in ledger)",
              intended: "remove absent record from ownership ledger",
              ownershipBasis: managedRec.basis,
              reason: `MCP "${name}" is disabled and already absent from ${configPath}`,
              targetMutation: false,
              ledgerMutation: true,
            });
          } else if (isLegacy) {
            // T-LEG-05: Legacy v1 claim, disabled, target already absent -> ledger-only retire
            nextResolvedLegacySet.add(name);
            ledgerMutation = true;
            changeSummaries.push(`retire absent legacy v1 claim ${name}`);
            ops.push({
              domain: "mcp",
              action: "retire-legacy-absent",
              status: "change",
              destination: `${configPath}#${name}`,
              observed: "absent in target config (unverified legacy v1 claim)",
              intended: "record legacy v1 claim as resolved in ownership ledger",
              ownershipBasis: "legacy-v1-unverified",
              reason: `legacy v1 MCP "${name}" is disabled and already absent from ${configPath}`,
              targetMutation: false,
              ledgerMutation: true,
            });
          } else {
            // T-MCP-01: Disabled, absent, unmanaged -> keep (NEVER acquire ownership!)
            ops.push({
              domain: "mcp",
              action: "keep",
              status: "ok",
              destination: `${configPath}#${name}`,
              observed: "absent",
              intended: "omitted (disabled)",
              ownershipBasis: "none",
              reason: `MCP "${name}" is disabled and absent; no ownership recorded`,
              targetMutation: false,
              ledgerMutation: false,
            });
          }
          continue;
        }

        // hasExisting === true && desired === null
        if (managedRec) {
          if (existingDigest === managedRec.digest || opts.force) {
            // T-MCP-03 / T-MCP-04 (forced): Remove managed entry and drop from ledger
            delete existingMap[name];
            if (agent === "codex") codexUpdates.set(name, null);
            targetMutation = true;
            ledgerMutation = true;
            basisUsed = opts.force && existingDigest !== managedRec.digest ? "forced" : "managed";
            changeSummaries.push(`remove disabled MCP ${name}`);
            ops.push({
              domain: "mcp",
              action: "mcp-remove",
              status: "change",
              destination: `${configPath}#${name}`,
              observed:
                existingDigest === managedRec.digest
                  ? "managed entry matches recorded digest"
                  : "managed entry externally modified (overridden by --force)",
              intended: "remove disabled MCP entry and drop ownership record",
              ownershipBasis: basisUsed,
              reason: `MCP "${name}" is disabled in canonical config`,
              targetMutation: true,
              ledgerMutation: true,
            });
          } else {
            // T-MCP-04: Externally modified managed entry -> conflict
            nextAgentMcp[name] = managedRec;
            ops.push({
              domain: "mcp",
              action: "conflict",
              status: "conflict",
              destination: `${configPath}#${name}`,
              observed: "managed entry was externally modified since last sync",
              intended: "remove disabled MCP entry",
              ownershipBasis: "managed-externally-modified",
              reason: `MCP "${name}" in ${configPath} was modified outside sync-agents; refusing to delete disabled entry`,
              nextStep: "Inspect local changes or re-run with --force to delete",
              targetMutation: false,
              ledgerMutation: false,
            });
          }
          continue;
        }

        if (isLegacy) {
          // T-LEG-04: Legacy v1 unverified claim on existing target while disabled!
          if (opts.force) {
            delete existingMap[name];
            if (agent === "codex") codexUpdates.set(name, null);
            nextResolvedLegacySet.add(name);
            targetMutation = true;
            ledgerMutation = true;
            basisUsed = "forced";
            changeSummaries.push(`remove legacy-claimed disabled MCP ${name}`);
            ops.push({
              domain: "mcp",
              action: "mcp-remove-legacy",
              status: "change",
              destination: `${configPath}#${name}`,
              observed: "existing entry with unverified legacy v1 claim",
              intended: "delete entry and retire legacy v1 claim (no phantom ownership)",
              ownershipBasis: "forced",
              reason: `explicit --force authorized deleting legacy-claimed disabled MCP "${name}"`,
              targetMutation: true,
              ledgerMutation: true,
            });
          } else {
            ops.push({
              domain: "mcp",
              action: "conflict",
              status: "conflict",
              destination: `${configPath}#${name}`,
              observed: "existing entry listed only in legacy v1 .mcp-managed.json (unverified provenance)",
              intended: "omitted (disabled)",
              ownershipBasis: "legacy-v1-unverified",
              reason: `MCP "${name}" is disabled in canonical config, but ${configPath} has an existing entry with unverified legacy v1 provenance`,
              nextStep: `Re-run with --force to delete it, or remove/rename <hub>/mcp/${name} and run --disown-legacy ${agent}:${name} to retain it unowned`,
              targetMutation: false,
              ledgerMutation: false,
            });
          }
          continue;
        }

        // T-MCP-02: Unmanaged collision on disabled canonical MCP!
        // NEVER add to nextAgentMcp!
        if (opts.force) {
          delete existingMap[name];
          if (agent === "codex") codexUpdates.set(name, null);
          targetMutation = true;
          // NOTE: ledgerMutation stays false — forced deletion of an unmanaged disabled entry
          // leaves NO phantom ownership record and does NOT increment state.generation!
          basisUsed = "forced";
          changeSummaries.push(`force-remove unmanaged disabled MCP ${name}`);
          ops.push({
            domain: "mcp",
            action: "mcp-remove-unmanaged",
            status: "change",
            destination: `${configPath}#${name}`,
            observed: "unmanaged personal entry",
            intended: "delete entry (ledger-neutral; no ownership recorded)",
            ownershipBasis: "forced",
            reason: `explicit --force authorized deleting unmanaged entry colliding with disabled MCP "${name}"`,
            targetMutation: true,
            ledgerMutation: false,
          });
        } else {
          ops.push({
            domain: "mcp",
            action: "conflict",
            status: "conflict",
            destination: `${configPath}#${name}`,
            observed: "unmanaged personal entry exists in target config",
            intended: "omitted (disabled in canonical config)",
            ownershipBasis: "unmanaged",
            reason: `MCP "${name}" is disabled in canonical config, but an unmanaged entry exists in ${configPath}; preserving it`,
            nextStep: "Remove it manually, rename the canonical server, or re-run with --force to delete",
            targetMutation: false,
            ledgerMutation: false,
          });
        }
        continue;
      }

      // ---- ENABLED (desired !== null) ----
      const desiredDigest = sha256Hex(stableJson(desired));

      if (!hasExisting) {
        // T-MCP-06 & T-LEG-02: Target does not have this server -> safe to add
        existingMap[name] = desired;
        if (agent === "codex") codexUpdates.set(name, desired);
        nextAgentMcp[name] = {
          configPath,
          digest: desiredDigest,
          basis: "created",
          updatedAt: now,
        };
        if (isLegacy) nextResolvedLegacySet.add(name);
        targetMutation = true;
        ledgerMutation = true;
        if (basisUsed === "managed") basisUsed = "created";
        changeSummaries.push(`add MCP ${name}`);
        ops.push({
          domain: "mcp",
          action: "mcp-add",
          status: "change",
          destination: `${configPath}#${name}`,
          observed: isLegacy ? "absent (legacy v1 claim)" : "absent",
          intended: `add MCP "${name}" to ${configPath}`,
          ownershipBasis: "created",
          reason: `MCP "${name}" is absent from ${configPath}`,
          targetMutation: true,
          ledgerMutation: true,
        });
        continue;
      }

      // hasExisting === true && desired !== null
      if (managedRec) {
        const matchesDesired = existingDigest === desiredDigest;
        const matchesRecorded = existingDigest === managedRec.digest;

        if (matchesDesired && matchesRecorded) {
          // T-MCP-09: Exact match & fresh digest -> zero churn!
          nextAgentMcp[name] = managedRec;
          ops.push({
            domain: "mcp",
            action: "keep",
            status: "ok",
            destination: `${configPath}#${name}`,
            observed: "managed entry matches canonical spec and recorded digest",
            intended: `MCP "${name}" in ${configPath}`,
            ownershipBasis: managedRec.basis,
            reason: "in sync",
            targetMutation: false,
            ledgerMutation: false,
          });
          continue;
        }

        if (matchesDesired && !matchesRecorded) {
          // T-MCP-10: Target matches desired, but stored digest is stale -> visible ledger-only op!
          nextAgentMcp[name] = {
            ...managedRec,
            configPath,
            digest: desiredDigest,
            updatedAt: now,
          };
          ledgerMutation = true;
          changeSummaries.push(`refresh digest for MCP ${name}`);
          ops.push({
            domain: "mcp",
            action: "refresh-mcp-digest",
            status: "change",
            destination: `${configPath}#${name}`,
            observed: "managed entry matches canonical spec, but stored ledger digest is stale",
            intended: "refresh stored digest in ownership ledger",
            ownershipBasis: managedRec.basis,
            reason: `ledger digest for managed MCP "${name}" differs from current target entry`,
            targetMutation: false,
            ledgerMutation: true,
          });
          continue;
        }

        if (matchesRecorded || opts.force) {
          // T-MCP-11 / T-MCP-12 (forced): Update managed entry
          existingMap[name] = desired;
          if (agent === "codex") codexUpdates.set(name, desired);
          const nextBasis: OwnershipBasis =
            !matchesRecorded && opts.force ? "forced" : managedRec.basis;
          nextAgentMcp[name] = {
            configPath,
            digest: desiredDigest,
            basis: nextBasis,
            updatedAt: now,
          };
          targetMutation = true;
          ledgerMutation = true;
          if (nextBasis === "forced") basisUsed = "forced";
          changeSummaries.push(`update MCP ${name}`);
          ops.push({
            domain: "mcp",
            action: "mcp-update",
            status: "change",
            destination: `${configPath}#${name}`,
            observed: matchesRecorded
              ? "managed entry matches previous recorded digest (canonical changed)"
              : "managed entry externally modified (overridden by --force)",
            intended: `update MCP "${name}" in ${configPath}`,
            ownershipBasis: nextBasis,
            reason: matchesRecorded
              ? "canonical MCP spec changed and target entry was not externally modified"
              : "explicit --force authorized overwriting externally modified managed entry",
            targetMutation: true,
            ledgerMutation: true,
          });
        } else {
          // T-MCP-12: Managed entry externally modified -> conflict!
          nextAgentMcp[name] = managedRec;
          ops.push({
            domain: "mcp",
            action: "conflict",
            status: "conflict",
            destination: `${configPath}#${name}`,
            observed: "managed entry in target config was modified outside sync-agents",
            intended: `update MCP "${name}" in ${configPath}`,
            ownershipBasis: "managed-externally-modified",
            reason: `MCP "${name}" in ${configPath} differs from both canonical spec and recorded digest`,
            nextStep: "Inspect local changes or re-run with --force to replace",
            targetMutation: false,
            ledgerMutation: false,
          });
        }
        continue;
      }

      // Unmanaged OR legacy v1 unverified entry (hasExisting && !managedRec)
      const isIdentical = existingDigest === desiredDigest;
      const provenanceLabel = isLegacy ? "legacy-v1-unverified" : "unmanaged";

      if (isIdentical) {
        // T-MCP-07 / T-LEG-01: Identical unmanaged or legacy v1 -> ledger-only adoption!
        if (opts.adopt || opts.force) {
          nextAgentMcp[name] = {
            configPath,
            digest: desiredDigest,
            basis: "adopted",
            updatedAt: now,
          };
          if (isLegacy) nextResolvedLegacySet.add(name);
          ledgerMutation = true;
          changeSummaries.push(`adopt identical MCP ${name}`);
          ops.push({
            domain: "mcp",
            action: "adopt-mcp",
            status: "change",
            destination: `${configPath}#${name}`,
            observed: `${provenanceLabel} entry is identical to canonical spec`,
            intended: "record verified v2 ownership in ledger (target file unchanged)",
            ownershipBasis: "adopted",
            reason: `explicit ${opts.adopt ? "--adopt" : "--force"} authorized adopting identical MCP "${name}"`,
            targetMutation: false,
            ledgerMutation: true,
          });
        } else {
          ops.push({
            domain: "mcp",
            action: "conflict",
            status: "conflict",
            destination: `${configPath}#${name}`,
            observed: `${provenanceLabel} entry matches canonical spec`,
            intended: `managed MCP "${name}" in ${configPath}`,
            ownershipBasis: provenanceLabel,
            reason: isLegacy
              ? `MCP "${name}" in ${configPath} matches canonical spec, but legacy v1 .mcp-managed.json provenance is unverified`
              : `MCP "${name}" already exists in ${configPath} (unmanaged, identical)`,
            nextStep: "Re-run with --adopt to record verified v2 ownership without rewriting config",
            targetMutation: false,
            ledgerMutation: false,
          });
        }
      } else {
        // T-MCP-08 / T-LEG-03: Differing unmanaged or legacy v1
        if (opts.force) {
          existingMap[name] = desired;
          if (agent === "codex") codexUpdates.set(name, desired);
          nextAgentMcp[name] = {
            configPath,
            digest: desiredDigest,
            basis: "forced",
            updatedAt: now,
          };
          if (isLegacy) nextResolvedLegacySet.add(name);
          targetMutation = true;
          ledgerMutation = true;
          basisUsed = "forced";
          changeSummaries.push(`replace MCP ${name}`);
          ops.push({
            domain: "mcp",
            action: "mcp-replace",
            status: "change",
            destination: `${configPath}#${name}`,
            observed: `${provenanceLabel} entry differs from canonical spec`,
            intended: `replace MCP "${name}" in ${configPath}`,
            ownershipBasis: "forced",
            reason: `explicit --force authorized replacing differing ${provenanceLabel} MCP "${name}"`,
            targetMutation: true,
            ledgerMutation: true,
          });
        } else {
          ops.push({
            domain: "mcp",
            action: "conflict",
            status: "conflict",
            destination: `${configPath}#${name}`,
            observed: `${provenanceLabel} entry differs from canonical spec`,
            intended: `managed MCP "${name}" in ${configPath}`,
            ownershipBasis: provenanceLabel,
            reason: isLegacy
              ? `MCP "${name}" in ${configPath} differs from canonical spec and legacy v1 provenance is unverified`
              : `MCP "${name}" already exists in ${configPath} and differs`,
            nextStep: "Inspect differences, re-run with --force to replace, or rename/withdraw the canonical entry",
            targetMutation: false,
            ledgerMutation: false,
          });
        }
      }
    }

    // 2. Prune removed canonical servers that have verified v2 ownership (T-MCP-13 & T-MCP-05)
    for (const oldName of Object.keys(prevManaged).sort()) {
      if (servers.has(oldName)) continue;
      const managedRec = prevManaged[oldName]!;
      const hasExisting = Object.prototype.hasOwnProperty.call(existingMap, oldName);

      if (!hasExisting) {
        ledgerMutation = true;
        changeSummaries.push(`drop absent removed MCP record ${oldName}`);
        ops.push({
          domain: "mcp",
          action: "drop-absent-mcp",
          status: "change",
          destination: `${configPath}#${oldName}`,
          observed: "absent in target config (removed canonical server still in ledger)",
          intended: "remove stale record from ownership ledger",
          ownershipBasis: managedRec.basis,
          reason: `removed MCP "${oldName}" is already absent from ${configPath}`,
          targetMutation: false,
          ledgerMutation: true,
        });
        continue;
      }

      const comparableExisting = normalizeComparable(agent, existingMap[oldName]);
      const existingDigest = sha256Hex(stableJson(comparableExisting));

      if (existingDigest === managedRec.digest || opts.force) {
        delete existingMap[oldName];
        if (agent === "codex") codexUpdates.set(oldName, null);
        targetMutation = true;
        ledgerMutation = true;
        if (existingDigest !== managedRec.digest && opts.force) basisUsed = "forced";
        changeSummaries.push(`prune removed MCP ${oldName}`);
        ops.push({
          domain: "mcp",
          action: "mcp-prune",
          status: "change",
          destination: `${configPath}#${oldName}`,
          observed:
            existingDigest === managedRec.digest
              ? "managed entry matches recorded digest"
              : "managed entry externally modified (overridden by --force)",
          intended: `prune removed MCP "${oldName}" from ${configPath}`,
          ownershipBasis: existingDigest === managedRec.digest ? managedRec.basis : "forced",
          reason: `canonical MCP "${oldName}" was removed`,
          targetMutation: true,
          ledgerMutation: true,
        });
      } else {
        nextAgentMcp[oldName] = managedRec;
        ops.push({
          domain: "mcp",
          action: "conflict",
          status: "conflict",
          destination: `${configPath}#${oldName}`,
          observed: "managed entry was externally modified since last sync",
          intended: `prune removed MCP "${oldName}" from ${configPath}`,
          ownershipBasis: "managed-externally-modified",
          reason: `MCP "${oldName}" in ${configPath} was modified outside sync-agents; refusing to prune`,
          nextStep: "Inspect local changes or re-run with --force to prune",
          targetMutation: false,
          ledgerMutation: false,
        });
      }
    }

    // 3. Handle remaining legacy v1 claims for servers removed from canonical config (T-LEG-05 & T-LEG-06)
    for (const legacyName of [...legacySet].sort()) {
      if (servers.has(legacyName)) continue;
      if (Object.prototype.hasOwnProperty.call(prevManaged, legacyName)) continue;
      const hasExisting = Object.prototype.hasOwnProperty.call(existingMap, legacyName);

      if (!hasExisting) {
        // T-LEG-05: Already absent -> ledger-only retire!
        nextResolvedLegacySet.add(legacyName);
        ledgerMutation = true;
        changeSummaries.push(`retire absent legacy v1 claim ${legacyName}`);
        ops.push({
          domain: "mcp",
          action: "retire-legacy-absent",
          status: "change",
          destination: `${configPath}#${legacyName}`,
          observed: "absent in target config (removed canonical server in legacy v1 manifest)",
          intended: "retire legacy v1 claim in ownership ledger",
          ownershipBasis: "legacy-v1-unverified",
          reason: `legacy v1 MCP "${legacyName}" is absent from both canonical hub and ${configPath}`,
          targetMutation: false,
          ledgerMutation: true,
        });
        continue;
      }

      // T-LEG-06: Removed canonical + still present in target!
      if (disownByAgent[agent].has(legacyName)) {
        nextResolvedLegacySet.add(legacyName);
        ledgerMutation = true;
        changeSummaries.push(`disown legacy v1 claim ${legacyName}`);
        ops.push({
          domain: "mcp",
          action: "disown-legacy",
          status: "change",
          destination: `${configPath}#${legacyName}`,
          observed: "existing personal entry with unverified legacy v1 claim (canonical removed)",
          intended: "retire legacy v1 claim in ledger and retain personal entry unowned",
          ownershipBasis: "legacy-v1-unverified",
          reason: `explicit --disown-legacy ${agent}:${legacyName} authorized retiring claim without modifying ${configPath}`,
          targetMutation: false,
          ledgerMutation: true,
        });
      } else if (opts.force) {
        delete existingMap[legacyName];
        if (agent === "codex") codexUpdates.set(legacyName, null);
        nextResolvedLegacySet.add(legacyName);
        targetMutation = true;
        ledgerMutation = true;
        basisUsed = "forced";
        changeSummaries.push(`prune legacy-claimed removed MCP ${legacyName}`);
        ops.push({
          domain: "mcp",
          action: "mcp-prune-legacy",
          status: "change",
          destination: `${configPath}#${legacyName}`,
          observed: "existing entry with unverified legacy v1 claim (canonical removed)",
          intended: `delete "${legacyName}" from ${configPath} and retire legacy v1 claim`,
          ownershipBasis: "forced",
          reason: `explicit --force authorized pruning legacy-claimed MCP "${legacyName}"`,
          targetMutation: true,
          ledgerMutation: true,
        });
      } else {
        ops.push({
          domain: "mcp",
          action: "conflict",
          status: "conflict",
          destination: `${configPath}#${legacyName}`,
          observed: "existing entry listed only in legacy v1 .mcp-managed.json (canonical removed)",
          intended: "verify whether to delete or retain personal entry",
          ownershipBasis: "legacy-v1-unverified",
          reason: `refusing to auto-prune "${legacyName}" from ${configPath}: legacy v1 provenance is unverified`,
          nextStep: `Run --disown-legacy ${agent}:${legacyName} to keep it unowned, or --force to delete it`,
          targetMutation: false,
          ledgerMutation: false,
        });
      }
    }

    // 4. Pre-render complete target file (and verify TOML preservation) in Phase 1!
    let renderedContent: string | undefined;
    if (targetMutation) {
      if (agent === "codex") {
        renderedContent = rewriteCodexToml(originalText, codexUpdates);
      } else {
        const nextDoc = { ...jsonDoc, mcpServers: existingMap };
        renderedContent = `${JSON.stringify(nextDoc, null, 2)}\n`;
      }
    }

    targets.push({
      agent,
      rootDir,
      configPath,
      ops,
      targetMutation,
      ledgerMutation,
      beforeSnapshot,
      renderedContent,
      targetMode,
      nextAgentMcp,
      nextResolvedLegacyV1: [...nextResolvedLegacySet].sort(),
      basis: basisUsed,
      summaryReason: changeSummaries.join("; ") || `sync ${agent} MCP config`,
    });
  }

  return { targets, globalOps };
}

export function applyMcpTarget(
  plan: PlannedMcpTarget,
  canonicalHubPath: string,
  state: OwnershipStateV2,
  statePath: string,
  journalPath: string,
  flags: { adopt: boolean; force: boolean; forceSkill: boolean },
  hooks?: ApplyHooks,
): OwnershipStateV2 {
  if (!plan.targetMutation && !plan.ledgerMutation) {
    return state;
  }

  const stateDelta: StateDelta = plan.ledgerMutation
    ? {
        kind: "mcp-target",
        agent: plan.agent,
        nextAgentMcp: plan.nextAgentMcp,
        resolvedLegacyV1: plan.nextResolvedLegacyV1,
      }
    : { kind: "none" };

  // Direct state-commit path for ledger-only operations (adopt-mcp, refresh-mcp-digest,
  // drop-absent-mcp, retire-legacy-absent, disown-legacy): verify unchanged target snapshot
  // and generation, then commit ownership state directly without entering the target-write journal.
  if (!plan.targetMutation && plan.ledgerMutation) {
    const live = captureFileSnapshot(plan.configPath);
    if (!snapshotsEqual(live, plan.beforeSnapshot)) {
      throw new Error(
        `stale snapshot: ${plan.configPath} changed after planning; refusing ledger-only update`,
      );
    }
    hooks?.beforeLedgerOnlyCommit?.(`mcp-ledger ${plan.agent}`);
    const nextState = applyStateDelta(state, stateDelta);
    saveOwnershipState(statePath, nextState);
    return nextState;
  }

  // Target-mutating MCP write: 4-step write-ahead journal protocol.
  const rendered = plan.renderedContent!;
  const owner =
    plan.beforeSnapshot.kind === "file"
      ? { uid: plan.beforeSnapshot.uid, gid: plan.beforeSnapshot.gid }
      : predictNewFileOwner(dirname(plan.configPath));

  const afterSnapshot: TargetSnapshot = {
    kind: "file",
    sha256: sha256Hex(Buffer.from(rendered, "utf8")),
    mode: plan.targetMode & 0o7777,
    uid: owner.uid,
    gid: owner.gid,
  };

  const opId = `mcp-${plan.agent}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const journal: PendingJournalRecord = {
    version: 1,
    opId,
    hubPath: canonicalHubPath,
    expectedStateGeneration: state.generation,
    targetStateGeneration: plan.ledgerMutation ? state.generation + 1 : state.generation,
    kind: "mcp-write",
    authorization: {
      flags,
      basis: plan.basis,
      reason: plan.summaryReason,
    },
    destination: plan.configPath,
    before: plan.beforeSnapshot,
    after: afterSnapshot,
    stateDelta,
  };

  writeJournal(journalPath, journal);
  hooks?.beforeTargetMutate?.(journal);

  // Re-verify COMPLETE target snapshot (bytes, mode, uid, gid, existence) strictly BEFORE mutation.
  const live = captureFileSnapshot(plan.configPath);
  if (!snapshotsEqual(live, plan.beforeSnapshot)) {
    clearJournal(journalPath);
    throw new Error(
      `stale snapshot: ${plan.configPath} changed after planning (contents, permissions, or ownership drifted); preserving newer file`,
    );
  }

  atomicWriteDurable(plan.configPath, rendered, plan.targetMode, plan.targetMode);
  hooks?.afterTargetMutate?.(journal);

  let nextState = state;
  if (plan.ledgerMutation) {
    nextState = applyStateDelta(state, stateDelta);
    saveOwnershipState(statePath, nextState);
    hooks?.afterStateCommit?.(journal);
  }

  clearJournal(journalPath);
  return nextState;
}
