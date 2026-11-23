import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MCP_ADAPTER_BY_ID,
  MCP_ADAPTERS,
  normalizeAntigravityComparable,
  normalizeClaudeComparable,
  type McpAdapterDef,
} from "./adapters.ts";
import {
  atomicWriteDurable,
  captureFileSnapshot,
  isPlainObject,
  parseJsonFile,
  parseStrictJsonTargetFile,
  physicalPath,
  predictNewEntryOwner,
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
import { rewriteCodexToml } from "./toml-edit.ts";
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

export { normalizeAntigravityComparable, normalizeClaudeComparable };

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Per-server compiled entries, keyed by agent. `null` means the server is disabled for that agent;
 * an agent outside the run's scope has no key at all, so it can never be mistaken for disabled.
 */
export type CompiledServerMap = Map<string, Partial<Record<AgentId, Record<string, unknown> | null>>>;

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

type TargetPlanCtx = {
  adapter: McpAdapterDef;
  configPath: string;
  existingMap: Record<string, unknown>;
  codexUpdates: Map<string, Record<string, unknown> | null>;
  nextAgentMcp: Record<string, ManagedMcpRecord>;
  nextResolvedLegacySet: Set<string>;
  ops: PlannedOp[];
  changeSummaries: string[];
  targetMutation: boolean;
  ledgerMutation: boolean;
  basisUsed: OwnershipBasis | "managed";
  now: string;
  opts: { adopt: boolean; force: boolean; configPath: string };
};

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

export function mergeSpec(
  base: McpServerSpec,
  override: McpServerSpec | undefined,
  sourceLabel: string,
): McpServerSpec {
  if (!override) return { ...base };

  const baseFamily = detectFamily(base);
  const ovFamily = detectFamily(override);

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

  return MCP_ADAPTER_BY_ID[agent].compile(transport, spec, serverName, sourceLabel);
}

export function loadCanonicalServers(
  canonicalHubPath: string,
  activeTargets?: ReadonlySet<AgentId>,
): CompiledServerMap {
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

    const legacyGeminiSub = join(serverDir, "gemini", "mcp.json");
    if (existsSync(legacyGeminiSub)) {
      throw new Error(
        `${legacyGeminiSub}: "gemini" override was renamed to "antigravity" (Antigravity uses ~/.gemini/config/mcp_config.json; Gemini CLI ~/.gemini/settings.json is not currently supported)`,
      );
    }

    const rawDoc = parseJsonFile(basePath) as RawMcpDocument;
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

    const compiled: Partial<Record<AgentId, Record<string, unknown> | null>> = {};

    for (const agent of ALL_AGENTS) {
      // Inactive targets are never planned, so skip compiling for them: an adapter that is
      // excluded by --targets/disabledTargets must not reject a transport it does not support.
      if (activeTargets && !activeTargets.has(agent)) continue;
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
        const subRaw = parseJsonFile(subPath);
        const subOv = parseSpecSnippet(subRaw, subPath);
        resolved = mergeSpec(resolved, subOv, subPath);
      }

      compiled[agent] = compileAgentEntry(agent, name, resolved, basePath);
    }

    result.set(name, compiled);
  }

  return result;
}

function validateDisownRequests(
  disownLegacy: Array<{ agent: AgentId; name: string }>,
  legacyV1: LegacyManifestV1 | null,
  servers: CompiledServerMap,
): { disownByAgent: Record<AgentId, Set<string>>; globalOps: PlannedOp[] } {
  const globalOps: PlannedOp[] = [];
  const disownByAgent = {} as Record<AgentId, Set<string>>;
  for (const agent of ALL_AGENTS) disownByAgent[agent] = new Set();

  for (const req of disownLegacy) {
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

  return { disownByAgent, globalOps };
}

function planDisabledServerOp(
  ctx: TargetPlanCtx,
  name: string,
  hasExisting: boolean,
  existingDigest: string | null,
  managedRec: ManagedMcpRecord | undefined,
  isLegacy: boolean,
): void {
  const { adapter, configPath } = ctx;
  const agent = adapter.id;

  if (!hasExisting) {
    if (managedRec) {
      ctx.ledgerMutation = true;
      ctx.changeSummaries.push(`drop absent MCP record ${name}`);
      ctx.ops.push({
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
      ctx.nextResolvedLegacySet.add(name);
      ctx.ledgerMutation = true;
      ctx.changeSummaries.push(`retire absent legacy v1 claim ${name}`);
      ctx.ops.push({
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
      ctx.ops.push({
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
    return;
  }

  if (managedRec) {
    if (existingDigest === managedRec.digest || ctx.opts.force) {
      delete ctx.existingMap[name];
      if (adapter.format === "toml") ctx.codexUpdates.set(name, null);
      ctx.targetMutation = true;
      ctx.ledgerMutation = true;
      ctx.basisUsed =
        ctx.opts.force && existingDigest !== managedRec.digest ? "forced" : "managed";
      ctx.changeSummaries.push(`remove disabled MCP ${name}`);
      ctx.ops.push({
        domain: "mcp",
        action: "mcp-remove",
        status: "change",
        destination: `${configPath}#${name}`,
        observed:
          existingDigest === managedRec.digest
            ? "managed entry matches recorded digest"
            : "managed entry externally modified (overridden by --force)",
        intended: "remove disabled MCP entry and drop ownership record",
        ownershipBasis: ctx.basisUsed,
        reason: `MCP "${name}" is disabled in canonical config`,
        targetMutation: true,
        ledgerMutation: true,
      });
    } else {
      ctx.nextAgentMcp[name] = managedRec;
      ctx.ops.push({
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
    return;
  }

  if (isLegacy) {
    if (ctx.opts.force) {
      delete ctx.existingMap[name];
      if (adapter.format === "toml") ctx.codexUpdates.set(name, null);
      ctx.nextResolvedLegacySet.add(name);
      ctx.targetMutation = true;
      ctx.ledgerMutation = true;
      ctx.basisUsed = "forced";
      ctx.changeSummaries.push(`remove legacy-claimed disabled MCP ${name}`);
      ctx.ops.push({
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
      ctx.ops.push({
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
    return;
  }

  // Unmanaged collision on disabled canonical MCP: NEVER acquire ownership!
  if (ctx.opts.force) {
    delete ctx.existingMap[name];
    if (adapter.format === "toml") ctx.codexUpdates.set(name, null);
    ctx.targetMutation = true;
    ctx.basisUsed = "forced";
    ctx.changeSummaries.push(`force-remove unmanaged disabled MCP ${name}`);
    ctx.ops.push({
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
    ctx.ops.push({
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
}

function planEnabledServerOp(
  ctx: TargetPlanCtx,
  name: string,
  desired: Record<string, unknown>,
  hasExisting: boolean,
  existingDigest: string | null,
  managedRec: ManagedMcpRecord | undefined,
  isLegacy: boolean,
): void {
  const { adapter, configPath } = ctx;
  const desiredDigest = sha256Hex(stableJson(desired));

  if (!hasExisting) {
    ctx.existingMap[name] = desired;
    if (adapter.format === "toml") ctx.codexUpdates.set(name, desired);
    ctx.nextAgentMcp[name] = {
      configPath,
      digest: desiredDigest,
      basis: "created",
      updatedAt: ctx.now,
    };
    if (isLegacy) ctx.nextResolvedLegacySet.add(name);
    ctx.targetMutation = true;
    ctx.ledgerMutation = true;
    if (ctx.basisUsed === "managed") ctx.basisUsed = "created";
    ctx.changeSummaries.push(`add MCP ${name}`);
    ctx.ops.push({
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
    return;
  }

  if (managedRec) {
    const matchesDesired = existingDigest === desiredDigest;
    const matchesRecorded = existingDigest === managedRec.digest;

    if (matchesDesired && matchesRecorded) {
      ctx.nextAgentMcp[name] = managedRec;
      ctx.ops.push({
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
      return;
    }

    if (matchesDesired && !matchesRecorded) {
      ctx.nextAgentMcp[name] = {
        ...managedRec,
        configPath,
        digest: desiredDigest,
        updatedAt: ctx.now,
      };
      ctx.ledgerMutation = true;
      ctx.changeSummaries.push(`refresh digest for MCP ${name}`);
      ctx.ops.push({
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
      return;
    }

    if (matchesRecorded || ctx.opts.force) {
      ctx.existingMap[name] = desired;
      if (adapter.format === "toml") ctx.codexUpdates.set(name, desired);
      const nextBasis: OwnershipBasis =
        !matchesRecorded && ctx.opts.force ? "forced" : managedRec.basis;
      ctx.nextAgentMcp[name] = {
        configPath,
        digest: desiredDigest,
        basis: nextBasis,
        updatedAt: ctx.now,
      };
      ctx.targetMutation = true;
      ctx.ledgerMutation = true;
      if (nextBasis === "forced") ctx.basisUsed = "forced";
      ctx.changeSummaries.push(`update MCP ${name}`);
      ctx.ops.push({
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
      ctx.nextAgentMcp[name] = managedRec;
      ctx.ops.push({
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
    return;
  }

  const isIdentical = existingDigest === desiredDigest;
  const provenanceLabel = isLegacy ? "legacy-v1-unverified" : "unmanaged";

  if (isIdentical) {
    if (ctx.opts.adopt || ctx.opts.force) {
      ctx.nextAgentMcp[name] = {
        configPath,
        digest: desiredDigest,
        basis: "adopted",
        updatedAt: ctx.now,
      };
      if (isLegacy) ctx.nextResolvedLegacySet.add(name);
      ctx.ledgerMutation = true;
      ctx.changeSummaries.push(`adopt identical MCP ${name}`);
      ctx.ops.push({
        domain: "mcp",
        action: "adopt-mcp",
        status: "change",
        destination: `${configPath}#${name}`,
        observed: `${provenanceLabel} entry is identical to canonical spec`,
        intended: "record verified v2 ownership in ledger (target file unchanged)",
        ownershipBasis: "adopted",
        reason: `explicit ${ctx.opts.adopt ? "--adopt" : "--force"} authorized adopting identical MCP "${name}"`,
        targetMutation: false,
        ledgerMutation: true,
      });
    } else {
      ctx.ops.push({
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
    return;
  }

  if (ctx.opts.force) {
    ctx.existingMap[name] = desired;
    if (adapter.format === "toml") ctx.codexUpdates.set(name, desired);
    ctx.nextAgentMcp[name] = {
      configPath,
      digest: desiredDigest,
      basis: "forced",
      updatedAt: ctx.now,
    };
    if (isLegacy) ctx.nextResolvedLegacySet.add(name);
    ctx.targetMutation = true;
    ctx.ledgerMutation = true;
    ctx.basisUsed = "forced";
    ctx.changeSummaries.push(`replace MCP ${name}`);
    ctx.ops.push({
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
    ctx.ops.push({
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

function planRemovedManagedOp(
  ctx: TargetPlanCtx,
  oldName: string,
  managedRec: ManagedMcpRecord,
): void {
  const { adapter, configPath } = ctx;
  const hasExisting = Object.prototype.hasOwnProperty.call(ctx.existingMap, oldName);

  if (!hasExisting) {
    ctx.ledgerMutation = true;
    ctx.changeSummaries.push(`drop absent removed MCP record ${oldName}`);
    ctx.ops.push({
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
    return;
  }

  const comparableExisting = adapter.normalizeComparable(ctx.existingMap[oldName]);
  const existingDigest = sha256Hex(stableJson(comparableExisting));

  if (existingDigest === managedRec.digest || ctx.opts.force) {
    delete ctx.existingMap[oldName];
    if (adapter.format === "toml") ctx.codexUpdates.set(oldName, null);
    ctx.targetMutation = true;
    ctx.ledgerMutation = true;
    if (existingDigest !== managedRec.digest && ctx.opts.force) ctx.basisUsed = "forced";
    ctx.changeSummaries.push(`prune removed MCP ${oldName}`);
    ctx.ops.push({
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
    ctx.nextAgentMcp[oldName] = managedRec;
    ctx.ops.push({
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

function planRemovedLegacyOp(
  ctx: TargetPlanCtx,
  legacyName: string,
  disownSet: Set<string>,
): void {
  const { adapter, configPath } = ctx;
  const agent = adapter.id;
  const hasExisting = Object.prototype.hasOwnProperty.call(ctx.existingMap, legacyName);

  if (!hasExisting) {
    ctx.nextResolvedLegacySet.add(legacyName);
    ctx.ledgerMutation = true;
    ctx.changeSummaries.push(`retire absent legacy v1 claim ${legacyName}`);
    ctx.ops.push({
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
    return;
  }

  if (disownSet.has(legacyName)) {
    ctx.nextResolvedLegacySet.add(legacyName);
    ctx.ledgerMutation = true;
    ctx.changeSummaries.push(`disown legacy v1 claim ${legacyName}`);
    ctx.ops.push({
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
  } else if (ctx.opts.force) {
    delete ctx.existingMap[legacyName];
    if (adapter.format === "toml") ctx.codexUpdates.set(legacyName, null);
    ctx.nextResolvedLegacySet.add(legacyName);
    ctx.targetMutation = true;
    ctx.ledgerMutation = true;
    ctx.basisUsed = "forced";
    ctx.changeSummaries.push(`prune legacy-claimed removed MCP ${legacyName}`);
    ctx.ops.push({
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
    ctx.ops.push({
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

/**
 * Remedy appended to every refusal or conflict that is specific to one target. Planning
 * covers all active targets before anything is applied, so one target's refusal stops the
 * whole run; excluding that target is how an operator syncs the rest.
 */
export function targetOptOutHint(agent: AgentId, configPath: string): string {
  return `to sync everything else and leave ${agent}'s MCP config alone, add "disabledTargets": ["${agent}:mcp"] to ${configPath}, or pass --targets naming what to sync (${agent}:links keeps its rules and skill links)`;
}

const NOT_APPLIED = "no Phase 2 target or ledger changes were applied in this run";

function planSingleMcpTarget(
  adapter: McpAdapterDef,
  homeDir: string,
  servers: CompiledServerMap,
  state: OwnershipStateV2,
  legacyV1: LegacyManifestV1 | null,
  disownSet: Set<string>,
  now: string,
  opts: { adopt: boolean; force: boolean; configPath: string; configBase: string },
): PlannedMcpTarget | null {
  const rootDir = adapter.rootDir(homeDir, opts.configBase);
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) return null;

  const configPath = adapter.configPath(homeDir, opts.configBase);
  const beforeSnapshot = captureFileSnapshot(configPath);
  if (beforeSnapshot.kind !== "absent" && beforeSnapshot.kind !== "file") {
    throw new Error(`mcp-sync: expected regular file at ${configPath}; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`);
  }
  const targetMode = beforeSnapshot.kind === "file" ? beforeSnapshot.mode : adapter.defaultMode;
  const rootKey = adapter.rootKey ?? "mcpServers";

  // Universal JSONC sibling guard across all JSON adapters: refuse to silently create
  // a competing .json file when a .jsonc file already exists (e.g. opencode.jsonc).
  // Checked whether or not the .json exists: with both present, the tool's effective config is ambiguous.
  if (adapter.format === "json" && existsSync(`${configPath}c`)) {
    throw new Error(
      `mcp-sync: ${configPath}c exists: JSONC files with comments are unsupported until a comment-preserving editor is added; refusing to ${beforeSnapshot.kind === "absent" ? "create a separate" : "modify"} ${configPath}; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`,
    );
  }

  let originalText = "";
  let jsonDoc: Record<string, unknown> = {};
  let existingMap: Record<string, unknown> = {};
  // For adapters with a nested server map (OpenCode mcp.servers): the root object as read, and the
  // entries sitting directly under it in the previous layout.
  let rootObj: Record<string, unknown> = {};
  const legacyEntries: Record<string, unknown> = {};
  let nestedIsLegacyServer = false;

  if (beforeSnapshot.kind === "file") {
    if (adapter.format === "toml") {
      originalText = readFileSync(configPath, "utf8");
      let parsed: Record<string, unknown> = {};
      try {
        if (originalText.trim()) parsed = Bun.TOML.parse(originalText) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`mcp-sync: ${configPath}: invalid TOML (${msg}); ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`);
      }
      if (parsed.mcp_servers !== undefined && !isPlainObject(parsed.mcp_servers)) {
        throw new Error(
          `mcp-sync: ${configPath}: "mcp_servers" must be a TOML table; refusing to overwrite; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`,
        );
      }
      existingMap = isPlainObject(parsed.mcp_servers)
        ? { ...(parsed.mcp_servers as Record<string, unknown>) }
        : {};
    } else {
      let parsed: unknown;
      try {
        parsed = parseStrictJsonTargetFile(configPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`mcp-sync: ${msg}; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`);
      }
      if (!isPlainObject(parsed)) {
        throw new Error(`mcp-sync: ${configPath} must contain a JSON object; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`);
      }
      // Fail closed on corrupt root map (null, array, primitive) instead of silently clobbering!
      const rawMap = parsed[rootKey];
      if (rawMap !== undefined && !isPlainObject(rawMap)) {
        const foundType = Array.isArray(rawMap)
          ? "array"
          : rawMap === null
            ? "null"
            : typeof rawMap;
        throw new Error(
          `mcp-sync: ${configPath}: "${rootKey}" must be a JSON object (found ${foundType}); refusing to overwrite; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`,
        );
      }
      jsonDoc = parsed;
      rootObj = isPlainObject(rawMap) ? { ...rawMap } : {};
      if (adapter.nestedKey) {
        const nested = rootObj[adapter.nestedKey];
        if (nested !== undefined && !isPlainObject(nested)) {
          throw new Error(
            `mcp-sync: ${configPath}: "${rootKey}.${adapter.nestedKey}" must be a JSON object; refusing to overwrite; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`,
          );
        }
        existingMap = isPlainObject(nested) ? { ...nested } : {};
        // A map of servers holds only objects. Anything else at <rootKey>.<nestedKey> is the
        // previous layout's server *named* like the map (e.g. {"type": "local", ...}); treating it
        // as the map would write hub entries inside someone's server object.
        if (isPlainObject(nested) && Object.values(nested).some((v) => !isPlainObject(v))) {
          nestedIsLegacyServer = true;
          existingMap = {};
        }
        for (const [k, v] of Object.entries(rootObj)) {
          if (!adapter.reservedNames?.includes(k)) Object.defineProperty(legacyEntries, k, { value: v, enumerable: true, writable: true, configurable: true });
        }
      } else {
        existingMap = { ...rootObj };
      }
    }
  }

  // A ledger record owns an entry only in the file it was written for. A record for another
  // file (the adapter's config moved, e.g. OpenCode following $XDG_CONFIG_HOME) must never claim
  // a same-named entry here: that entry may be the user's. Such records are retired, and the
  // file they describe is left untouched.
  const prevManaged: Record<string, ManagedMcpRecord> = {};
  const staleRecords: Array<[string, ManagedMcpRecord]> = [];
  for (const [recName, rec] of Object.entries(state.mcp[adapter.id])) {
    if (rec.configPath === configPath || physicalPath(rec.configPath) === physicalPath(configPath)) {
      prevManaged[recName] = rec;
    }
    else staleRecords.push([recName, rec]);
  }
  const legacySet = legacyV1?.managed[adapter.id] ?? new Set<string>();

  const ctx: TargetPlanCtx = {
    adapter,
    configPath,
    existingMap,
    codexUpdates: new Map(),
    nextAgentMcp: {},
    nextResolvedLegacySet: new Set(state.resolvedLegacyV1[adapter.id]),
    ops: [],
    changeSummaries: [],
    targetMutation: false,
    ledgerMutation: false,
    basisUsed: "managed",
    now,
    opts,
  };

  // Keys of the root object the render drops (migrated or removed previous-layout entries).
  const migrated = new Set<string>();
  // Previous layout, at a name the current layout reserves (OpenCode's mcp.servers, mcp.timeout):
  // an entry agent-hub wrote there can never be migrated (the name is refused for this target), so
  // once its ledger digest still matches it is removed; otherwise the record is retired and what
  // is there is left alone, since it is no longer what agent-hub wrote. Never reported "absent".
  const handledReserved = new Set<string>();
  for (const name of adapter.reservedNames ?? []) {
    const rec = prevManaged[name];
    const present = Object.prototype.hasOwnProperty.call(rootObj, name);
    const isServerSlot = name === adapter.nestedKey ? nestedIsLegacyServer : present;
    if (!rec) continue;
    handledReserved.add(name);
    delete prevManaged[name];
    const value = rootObj[name];
    const matches =
      present &&
      isServerSlot &&
      adapter.legacyNormalizeComparable !== undefined &&
      sha256Hex(stableJson(adapter.legacyNormalizeComparable(value))) === rec.digest;
    ctx.ledgerMutation = true;
    if (matches) {
      migrated.add(name);
      if (name === adapter.nestedKey) nestedIsLegacyServer = false;
      ctx.targetMutation = true;
      ctx.changeSummaries.push(`remove ${name} from ${rootKey}`);
      ctx.ops.push({
        domain: "mcp",
        action: "mcp-remove-reserved-legacy",
        status: "change",
        destination: `${configPath}#${rootKey}.${name}`,
        observed: `server "${name}" written by sync-agents directly under ${rootKey}, in the previous layout`,
        intended: `remove it; "${name}" is one of ${adapter.label}'s own ${rootKey} keys, so it cannot be a server name`,
        ownershipBasis: rec.basis,
        reason: `${adapter.label} reserves ${rootKey}.${name}; the server sync-agents wrote there is unchanged since, so it is removed`,
        nextStep: `Rename the hub server if you still want it in ${adapter.label}`,
        targetMutation: true,
        ledgerMutation: true,
      });
    } else {
      ctx.changeSummaries.push(`retire record for ${rootKey}.${name}`);
      ctx.ops.push({
        domain: "mcp",
        action: "retire-reserved-record",
        status: "change",
        destination: `${configPath}#${rootKey}.${name}`,
        observed: present
          ? `${rootKey}.${name} is not the server sync-agents wrote there`
          : `${rootKey}.${name} is not in ${configPath}`,
        intended: `stop managing ${rootKey}.${name}; leave ${configPath} untouched`,
        ownershipBasis: rec.basis,
        reason: `${adapter.label} reserves ${rootKey}.${name}, so it is no longer a server sync-agents manages`,
        targetMutation: false,
        ledgerMutation: true,
      });
    }
  }
  if (nestedIsLegacyServer) {
    throw new Error(
      `mcp-sync: ${configPath}: "${rootKey}.${adapter.nestedKey}" holds values that are not server objects, so it is not ${adapter.label}'s server map (the previous layout's server named "${adapter.nestedKey}" looks like this); fix or remove it by hand; refusing to overwrite; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`,
    );
  }

  // Previous layout: entries directly under <rootKey>. One agent-hub wrote (its ledger digest
  // matches) moves into the nested map; any other entry named like a hub or managed server is a
  // conflict, never overwritten or duplicated. Unrelated entries stay where they are, reported.
  for (const name of Object.keys(legacyEntries).sort()) {
    const entry = legacyEntries[name];
    // Own-property lookup: a key like "__proto__" must not find Object.prototype as a record.
    const rec = Object.prototype.hasOwnProperty.call(prevManaged, name) ? prevManaged[name] : undefined;
    const legacyDigest = adapter.legacyNormalizeComparable
      ? sha256Hex(stableJson(adapter.legacyNormalizeComparable(entry)))
      : null;
    const inNested = Object.prototype.hasOwnProperty.call(existingMap, name);
    if (rec && !inNested && legacyDigest === rec.digest) {
      // Write it in the current shape: legacyToCurrent turns the old `enabled` into `disabled`.
      const migratedEntry = adapter.normalizeComparable(
        adapter.legacyToCurrent ? adapter.legacyToCurrent(entry) : entry,
      );
      existingMap[name] = migratedEntry;
      prevManaged[name] = { ...rec, digest: sha256Hex(stableJson(migratedEntry)) };
      migrated.add(name);
      // The record is re-baselined to the current shape's digest, so the ledger changes too.
      ctx.targetMutation = true;
      ctx.ledgerMutation = true;
      ctx.changeSummaries.push(`move ${name} to ${rootKey}.${adapter.nestedKey}`);
      ctx.ops.push({
        domain: "mcp",
        action: "mcp-migrate-layout",
        status: "change",
        destination: `${configPath}#${rootKey}.${name}`,
        observed: `entry "${name}" written by sync-agents directly under ${rootKey}`,
        intended: `move it to ${rootKey}.${adapter.nestedKey}.${name}`,
        ownershipBasis: rec.basis,
        reason: `${adapter.label} reads servers from ${rootKey}.${adapter.nestedKey}; the direct ${rootKey}.<name> layout is deprecated`,
        targetMutation: true,
        ledgerMutation: true,
      });
    } else if (rec || servers.has(name)) {
      ctx.ops.push({
        domain: "mcp",
        action: "conflict",
        status: "conflict",
        destination: `${configPath}#${rootKey}.${name}`,
        observed: rec
          ? `entry "${name}" under ${rootKey} differs from what sync-agents recorded`
          : `unmanaged entry "${name}" directly under ${rootKey}`,
        intended: `manage "${name}" at ${rootKey}.${adapter.nestedKey}.${name}`,
        ownershipBasis: rec ? rec.basis : "none",
        reason: `refusing to manage "${name}" in ${rootKey}.${adapter.nestedKey} while ${rootKey}.${name} also names it`,
        nextStep: servers.has(name)
          ? `Remove or rename ${rootKey}.${name} in ${configPath}, or rename the hub server`
          : `Remove or rename ${rootKey}.${name} in ${configPath}`,
        targetMutation: false,
        ledgerMutation: false,
      });
    } else {
      ctx.ops.push({
        domain: "mcp",
        action: "leave-legacy-unmanaged",
        status: "ok",
        destination: `${configPath}#${rootKey}.${name}`,
        observed: `entry "${name}" directly under ${rootKey} (the deprecated layout), not written by sync-agents`,
        intended: "leave it where it is",
        ownershipBasis: "none",
        reason: `sync-agents does not manage "${name}"; ${adapter.label} deprecates the direct ${rootKey}.<name> layout, so move it to ${rootKey}.${adapter.nestedKey}.${name} yourself when convenient`,
        targetMutation: false,
        ledgerMutation: false,
      });
    }
  }

  for (const [recName, rec] of staleRecords.sort(([a], [b]) => a.localeCompare(b))) {
    ctx.ledgerMutation = true;
    ctx.changeSummaries.push(`retire record for moved config ${rec.configPath}#${recName}`);
    ctx.ops.push({
      domain: "mcp",
      action: "retire-moved-record",
      status: "change",
      destination: `${rec.configPath}#${recName}`,
      observed: `ownership record for "${recName}" in ${rec.configPath}`,
      intended: `stop managing "${recName}" in ${rec.configPath}; ${adapter.label} now reads ${configPath}`,
      ownershipBasis: rec.basis,
      reason: `${adapter.label}'s config moved from ${rec.configPath} to ${configPath}; the record does not describe the file being synced, so it is retired and ${rec.configPath} is left untouched`,
      nextStep: `Remove "${recName}" from ${rec.configPath} by hand if you no longer want it there`,
      targetMutation: false,
      ledgerMutation: true,
    });
  }

  for (const [name, compiledPerAgent] of servers) {
    if (handledReserved.has(name)) continue;
    if (!Object.prototype.hasOwnProperty.call(compiledPerAgent, adapter.id)) {
      throw new Error(`mcp-sync: internal error: ${adapter.id} was planned but not compiled for "${name}"`);
    }
    const desired = compiledPerAgent[adapter.id]!;
    const hasExisting = Object.prototype.hasOwnProperty.call(ctx.existingMap, name);
    const managedRec = Object.prototype.hasOwnProperty.call(prevManaged, name)
      ? prevManaged[name]!
      : undefined;
    const isLegacy = !managedRec && legacySet.has(name);
    const comparableExisting = hasExisting
      ? adapter.normalizeComparable(ctx.existingMap[name])
      : null;
    const existingDigest = comparableExisting ? sha256Hex(stableJson(comparableExisting)) : null;

    if (desired === null) {
      planDisabledServerOp(ctx, name, hasExisting, existingDigest, managedRec, isLegacy);
    } else {
      planEnabledServerOp(ctx, name, desired, hasExisting, existingDigest, managedRec, isLegacy);
    }
  }

  for (const oldName of Object.keys(prevManaged).sort()) {
    if (servers.has(oldName)) continue;
    planRemovedManagedOp(ctx, oldName, prevManaged[oldName]!);
  }

  for (const legacyName of [...legacySet].sort()) {
    if (servers.has(legacyName)) continue;
    if (Object.prototype.hasOwnProperty.call(prevManaged, legacyName)) continue;
    planRemovedLegacyOp(ctx, legacyName, disownSet);
  }

  for (const op of ctx.ops) {
    if (op.status === "conflict") {
      const hint = targetOptOutHint(adapter.id, opts.configPath);
      op.nextStep = op.nextStep ? `${op.nextStep}; or ${hint}` : hint;
    }
  }

  let renderedContent: string | undefined;
  if (ctx.targetMutation) {
    if (adapter.format === "toml") {
      try {
        renderedContent = rewriteCodexToml(originalText, ctx.codexUpdates);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`mcp-sync: ${configPath}: ${msg}; ${NOT_APPLIED}; ${targetOptOutHint(adapter.id, opts.configPath)}`);
      }
    } else {
      let rootValue: Record<string, unknown> = ctx.existingMap;
      if (adapter.nestedKey) {
        // Keep the root object's key order and everything in it except migrated entries.
        // defineProperty, not assignment: a user key named "__proto__" must stay an own key.
        rootValue = {};
        const put = (k: string, v: unknown) =>
          Object.defineProperty(rootValue, k, { value: v, enumerable: true, writable: true, configurable: true });
        for (const [k, v] of Object.entries(rootObj)) {
          if (k === adapter.nestedKey) put(k, ctx.existingMap);
          else if (!migrated.has(k)) put(k, v);
        }
        if (!Object.prototype.hasOwnProperty.call(rootValue, adapter.nestedKey)) {
          put(adapter.nestedKey, ctx.existingMap);
        }
      }
      const nextDoc = { ...jsonDoc, [rootKey]: rootValue };
      renderedContent = `${JSON.stringify(nextDoc, null, 2)}\n`;
    }
  }

  return {
    agent: adapter.id,
    rootDir,
    configPath,
    ops: ctx.ops,
    targetMutation: ctx.targetMutation,
    ledgerMutation: ctx.ledgerMutation,
    beforeSnapshot,
    renderedContent,
    targetMode,
    nextAgentMcp: ctx.nextAgentMcp,
    nextResolvedLegacyV1: [...ctx.nextResolvedLegacySet].sort(),
    basis: ctx.basisUsed,
    summaryReason: ctx.changeSummaries.join("; ") || `sync ${adapter.id} MCP config`,
  };
}

export function planMcpSync(
  canonicalHubPath: string,
  homeDir: string,
  state: OwnershipStateV2,
  legacyV1: LegacyManifestV1 | null,
  opts: {
    adopt: boolean;
    force: boolean;
    activeTargets?: ReadonlySet<AgentId>;
    /** Resolved agent-hub config.json path, quoted in opt-out remedies. */
    configPath?: string;
    /** XDG config base (`$XDG_CONFIG_HOME` or `~/.config`); defaults to `~/.config`. */
    configBase?: string;
    disownLegacy: Array<{ agent: AgentId; name: string }>;
  },
): { targets: PlannedMcpTarget[]; globalOps: PlannedOp[] } {
  const servers = loadCanonicalServers(canonicalHubPath, opts.activeTargets);
  const now = new Date().toISOString();
  const { disownByAgent, globalOps } = validateDisownRequests(opts.disownLegacy, legacyV1, servers);

  const targets: PlannedMcpTarget[] = [];
  for (const adapter of MCP_ADAPTERS) {
    if (opts.activeTargets && !opts.activeTargets.has(adapter.id)) continue;
    const plan = planSingleMcpTarget(
      adapter,
      homeDir,
      servers,
      state,
      legacyV1,
      disownByAgent[adapter.id],
      now,
      {
        adopt: opts.adopt,
        force: opts.force,
        configPath: opts.configPath ?? "~/.config/agent-hub/config.json",
        configBase: opts.configBase ?? join(homeDir, ".config"),
      },
    );
    if (plan) targets.push(plan);
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

  // Direct state-commit path for ledger-only operations (no target-write journal).
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

  const rendered = plan.renderedContent!;
  const owner =
    plan.beforeSnapshot.kind === "file"
      ? { uid: plan.beforeSnapshot.uid, gid: plan.beforeSnapshot.gid }
      : predictNewEntryOwner(dirname(plan.configPath));

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
