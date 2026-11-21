#!/usr/bin/env bun
/**
 * Compile canonical MCP server configs from ~/.agents/mcp/<name>/mcp.json
 * (with optional inline `overrides.<agent>` and/or `<agent>/mcp.json` files)
 * into each installed local coding agent's native config format:
 *
 *   - gemini: ~/.gemini/config/mcp_config.json   (JSON, mcpServers.<name>)
 *   - claude: ~/.claude.json                     (surgical JSON merge of mcpServers.<name>)
 *   - codex:  ~/.codex/config.toml               (surgical TOML tables [mcp_servers.<name>])
 *
 * Safety properties:
 * - Tracks managed server names in ~/.agents/.mcp-managed.json.
 * - Never overwrites an unmanaged entry unless --adopt (and identical) or --force.
 * - Prunes removed servers only if they were previously managed by sync-agents.
 * - Writes atomically via temp file + rename and preserves existing file modes.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type AgentId = "gemini" | "claude" | "codex";
const ALL_AGENTS: readonly AgentId[] = ["gemini", "claude", "codex"];

type McpServerSpec = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
};

type RawMcpDocument = {
  mcp?: McpServerSpec;
  overrides?: Partial<Record<AgentId, McpServerSpec>>;
};

type ManagedManifest = {
  version: 1;
  managed: Record<AgentId, string[]>;
};

const HOME = homedir();
const AGENTS_DIR = process.env.AGENTS_DIR || join(HOME, ".agents");
const MCP_ROOT = join(AGENTS_DIR, "mcp");
const MANAGED_PATH = join(AGENTS_DIR, ".mcp-managed.json");

let DRY_RUN = false;
let CHECK_ONLY = false;
let ADOPT = false;
let FORCE = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "-n" || arg === "--dry-run") DRY_RUN = true;
  else if (arg === "--check") {
    CHECK_ONLY = true;
    DRY_RUN = true;
  } else if (arg === "--adopt") ADOPT = true;
  else if (arg === "-f" || arg === "--force") FORCE = true;
  else if (arg === "-h" || arg === "--help") {
    console.log("Usage: mcp-sync.ts [--dry-run|-n] [--check] [--adopt] [--force]");
    process.exit(0);
  } else {
    console.error(`mcp-sync: unknown option: ${arg}`);
    process.exit(2);
  }
}

let drift = 0;
let conflicts = 0;

function noteChange(msg: string): void {
  drift += 1;
  console.log(`${DRY_RUN ? "[plan]" : "[sync]"} ${msg}`);
}

function noteConflict(msg: string): void {
  conflicts += 1;
  console.error(`[conflict] ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSpec(raw: unknown, sourceLabel: string, requireTransport: boolean): McpServerSpec {
  if (!isPlainObject(raw)) {
    throw new Error(`${sourceLabel}: expected JSON object`);
  }
  const body = "mcp" in raw ? raw.mcp : raw;
  if (!isPlainObject(body)) {
    throw new Error(`${sourceLabel}: "mcp" field must be an object`);
  }
  const spec: McpServerSpec = {};
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
  if (requireTransport && !spec.command && !spec.url && !spec.disabled) {
    throw new Error(`${sourceLabel}: must specify either "command" or "url"`);
  }
  return spec;
}

function mergeSpec(base: McpServerSpec, override?: McpServerSpec): McpServerSpec {
  if (!override) return { ...base };
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

function loadCanonicalServers(): Map<string, Record<AgentId, McpServerSpec>> {
  const result = new Map<string, Record<AgentId, McpServerSpec>>();
  if (!existsSync(MCP_ROOT)) return result;

  const entries = readdirSync(MCP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const name = entry.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`mcp-sync: invalid MCP server directory name: ${name}`);
    }
    const basePath = join(MCP_ROOT, name, "mcp.json");
    if (!existsSync(basePath)) continue;

    const rawDoc = JSON.parse(readFileSync(basePath, "utf8")) as RawMcpDocument;
    const baseSpec = parseSpec(rawDoc, basePath, false);
    const perAgent = {} as Record<AgentId, McpServerSpec>;

    for (const agent of ALL_AGENTS) {
      let resolved = { ...baseSpec };

      if (rawDoc.overrides && rawDoc.overrides[agent] !== undefined) {
        const inlineOv = parseSpec(
          { mcp: rawDoc.overrides[agent] },
          `${basePath}#overrides.${agent}`,
          false,
        );
        resolved = mergeSpec(resolved, inlineOv);
      }

      const subPath = join(MCP_ROOT, name, agent, "mcp.json");
      if (existsSync(subPath)) {
        const subRaw = JSON.parse(readFileSync(subPath, "utf8"));
        const subOv = parseSpec(subRaw, subPath, false);
        resolved = mergeSpec(resolved, subOv);
      }

      if (!resolved.disabled && !resolved.command && !resolved.url) {
        throw new Error(`${basePath}: resolved spec for ${agent} needs "command" or "url"`);
      }
      perAgent[agent] = resolved;
    }

    result.set(name, perAgent);
  }

  return result;
}

function loadManagedManifest(): ManagedManifest {
  if (!existsSync(MANAGED_PATH)) {
    return { version: 1, managed: { gemini: [], claude: [], codex: [] } };
  }
  const parsed = JSON.parse(readFileSync(MANAGED_PATH, "utf8")) as Partial<ManagedManifest>;
  return {
    version: 1,
    managed: {
      gemini: [...(parsed.managed?.gemini ?? [])],
      claude: [...(parsed.managed?.claude ?? [])],
      codex: [...(parsed.managed?.codex ?? [])],
    },
  };
}

function atomicWrite(filePath: string, content: string, fallbackMode = 0o644): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : fallbackMode;
  const tmpPath = join(dir, `.sync-agents-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmpPath, content, { mode });
  chmodSync(tmpPath, mode);
  renameSync(tmpPath, filePath);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toGeminiEntry(spec: McpServerSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (spec.command) out.command = spec.command;
  if (spec.args && spec.args.length > 0) out.args = spec.args;
  if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
  if (spec.url) out.url = spec.url;
  if (spec.headers && Object.keys(spec.headers).length > 0) out.headers = spec.headers;
  out.disabled = Boolean(spec.disabled);
  return out;
}

function toClaudeEntry(spec: McpServerSpec): Record<string, unknown> | null {
  if (spec.disabled) return null;
  const out: Record<string, unknown> = {};
  if (spec.url) {
    out.type = "http";
    out.url = spec.url;
    if (spec.headers && Object.keys(spec.headers).length > 0) out.headers = spec.headers;
  } else if (spec.command) {
    out.type = "stdio";
    out.command = spec.command;
    out.args = spec.args ?? [];
    if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
  }
  return out;
}

function normalizeClaudeComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (copy.command && !copy.type) copy.type = "stdio";
  if (copy.type === "stdio" && copy.args === undefined) copy.args = [];
  if (isPlainObject(copy.env) && Object.keys(copy.env).length === 0) delete copy.env;
  return copy;
}

function toCodexEntry(spec: McpServerSpec): Record<string, unknown> | null {
  if (spec.disabled) return null;
  const out: Record<string, unknown> = {};
  if (spec.command) out.command = spec.command;
  if (spec.args && spec.args.length > 0) out.args = spec.args;
  if (spec.url) out.url = spec.url;
  if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
  if (spec.headers && Object.keys(spec.headers).length > 0) out.http_headers = spec.headers;
  return out;
}

function normalizeCodexComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (Array.isArray(copy.args) && copy.args.length === 0) delete copy.args;
  if (isPlainObject(copy.env) && Object.keys(copy.env).length === 0) delete copy.env;
  if (isPlainObject(copy.http_headers) && Object.keys(copy.http_headers).length === 0) {
    delete copy.http_headers;
  }
  return copy;
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function renderCodexSection(name: string, entry: Record<string, unknown>): string {
  const key = formatTomlKey(name);
  const lines: string[] = [`[mcp_servers.${key}]`];
  if (typeof entry.command === "string") {
    lines.push(`command = ${JSON.stringify(entry.command)}`);
  }
  if (Array.isArray(entry.args) && entry.args.length > 0) {
    lines.push(`args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`);
  }
  if (typeof entry.url === "string") {
    lines.push(`url = ${JSON.stringify(entry.url)}`);
  }
  if (isPlainObject(entry.env) && Object.keys(entry.env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${key}.env]`);
    for (const [k, v] of Object.entries(entry.env as Record<string, string>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${formatTomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }
  if (isPlainObject(entry.http_headers) && Object.keys(entry.http_headers).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${key}.http_headers]`);
    for (const [k, v] of Object.entries(entry.http_headers as Record<string, string>).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      lines.push(`${formatTomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n");
}

function parseTomlHeaderMcpServer(line: string): string | null {
  const m = line.match(/^\s*\[\s*mcp_servers\.([^\s.\]]+|"[^"]+")(?:\.(?:env|http_headers))?\s*\]\s*(?:#.*)?$/);
  if (!m) return null;
  const raw = m[1]!;
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

function rewriteCodexToml(
  original: string,
  updates: Map<string, Record<string, unknown> | null>,
): string {
  const lines = original.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (isTomlTableHeader(line)) {
      const mcpName = parseTomlHeaderMcpServer(line);
      skipping = mcpName !== null && updates.has(mcpName);
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") {
    kept.pop();
  }

  const additions = [...updates.entries()]
    .filter(([, v]) => v !== null)
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [name, entry] of additions) {
    if (kept.length > 0) kept.push("");
    kept.push(renderCodexSection(name, entry!));
  }

  return `${kept.join("\n")}\n`;
}

function syncJsonAgent(
  agent: "gemini" | "claude",
  rootDir: string,
  configPath: string,
  servers: Map<string, Record<AgentId, McpServerSpec>>,
  prevManaged: Set<string>,
  nextManaged: Set<string>,
): void {
  if (!existsSync(rootDir)) return;

  const doc: Record<string, unknown> = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};
  const existingMap: Record<string, unknown> = isPlainObject(doc.mcpServers)
    ? { ...doc.mcpServers }
    : {};

  let changed = false;

  for (const [name, perAgent] of servers) {
    const desired =
      agent === "gemini" ? toGeminiEntry(perAgent.gemini) : toClaudeEntry(perAgent.claude);
    const hasExisting = Object.prototype.hasOwnProperty.call(existingMap, name);
    const isManaged = prevManaged.has(name);

    const comparableExisting = hasExisting
      ? agent === "claude"
        ? normalizeClaudeComparable(existingMap[name])
        : existingMap[name]
      : null;

    if (desired === null) {
      if (hasExisting && isManaged) {
        noteChange(`remove disabled MCP ${name} from ${configPath}`);
        delete existingMap[name];
        changed = true;
      }
      nextManaged.add(name);
      continue;
    }

    if (hasExisting && !isManaged) {
      if (stableJson(comparableExisting) === stableJson(desired)) {
        if (ADOPT || FORCE) {
          noteChange(`adopt identical MCP ${name} in ${configPath}`);
          nextManaged.add(name);
          changed = true;
        } else {
          noteConflict(
            `MCP "${name}" already exists in ${configPath} (unmanaged, identical; re-run with --adopt)`,
          );
        }
      } else if (FORCE) {
        noteChange(`replace MCP ${name} in ${configPath}`);
        existingMap[name] = desired;
        nextManaged.add(name);
        changed = true;
      } else {
        noteConflict(
          `MCP "${name}" already exists in ${configPath} and differs (re-run with --force to replace)`,
        );
      }
      continue;
    }

    if (!hasExisting || stableJson(comparableExisting) !== stableJson(desired)) {
      noteChange(`${hasExisting ? "update" : "add"} MCP ${name} in ${configPath}`);
      existingMap[name] = desired;
      changed = true;
    }
    nextManaged.add(name);
  }

  for (const oldName of prevManaged) {
    if (!servers.has(oldName) && Object.prototype.hasOwnProperty.call(existingMap, oldName)) {
      noteChange(`prune removed MCP ${oldName} from ${configPath}`);
      delete existingMap[oldName];
      changed = true;
    }
  }

  if (changed && !DRY_RUN) {
    doc.mcpServers = existingMap;
    atomicWrite(configPath, `${JSON.stringify(doc, null, 2)}\n`, agent === "claude" ? 0o600 : 0o644);
  }
}

function syncCodexAgent(
  rootDir: string,
  configPath: string,
  servers: Map<string, Record<AgentId, McpServerSpec>>,
  prevManaged: Set<string>,
  nextManaged: Set<string>,
): void {
  if (!existsSync(rootDir)) return;

  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const parsed = original.trim() ? (Bun.TOML.parse(original) as Record<string, unknown>) : {};
  const existingMap: Record<string, unknown> = isPlainObject(parsed.mcp_servers)
    ? (parsed.mcp_servers as Record<string, unknown>)
    : {};

  const updates = new Map<string, Record<string, unknown> | null>();
  let fileChanged = false;

  for (const [name, perAgent] of servers) {
    const desired = toCodexEntry(perAgent.codex);
    const hasExisting = Object.prototype.hasOwnProperty.call(existingMap, name);
    const isManaged = prevManaged.has(name);
    const comparableExisting = hasExisting ? normalizeCodexComparable(existingMap[name]) : null;

    if (desired === null) {
      if (hasExisting && isManaged) {
        noteChange(`remove disabled MCP ${name} from ${configPath}`);
        updates.set(name, null);
        fileChanged = true;
      }
      nextManaged.add(name);
      continue;
    }

    if (hasExisting && !isManaged) {
      if (stableJson(comparableExisting) === stableJson(desired)) {
        if (ADOPT || FORCE) {
          noteChange(`adopt identical MCP ${name} in ${configPath}`);
          nextManaged.add(name);
        } else {
          noteConflict(
            `MCP "${name}" already exists in ${configPath} (unmanaged, identical; re-run with --adopt)`,
          );
        }
      } else if (FORCE) {
        noteChange(`replace MCP ${name} in ${configPath}`);
        updates.set(name, desired);
        nextManaged.add(name);
        fileChanged = true;
      } else {
        noteConflict(
          `MCP "${name}" already exists in ${configPath} and differs (re-run with --force to replace)`,
        );
      }
      continue;
    }

    if (!hasExisting || stableJson(comparableExisting) !== stableJson(desired)) {
      noteChange(`${hasExisting ? "update" : "add"} MCP ${name} in ${configPath}`);
      updates.set(name, desired);
      fileChanged = true;
    }
    nextManaged.add(name);
  }

  for (const oldName of prevManaged) {
    if (!servers.has(oldName) && Object.prototype.hasOwnProperty.call(existingMap, oldName)) {
      noteChange(`prune removed MCP ${oldName} from ${configPath}`);
      updates.set(oldName, null);
      fileChanged = true;
    }
  }

  if (fileChanged && !DRY_RUN) {
    const rewritten = rewriteCodexToml(original, updates);
    // Sanity-parse the rewritten TOML before committing to disk.
    Bun.TOML.parse(rewritten);
    atomicWrite(configPath, rewritten, 0o600);
  }
}

function main(): void {
  const servers = loadCanonicalServers();
  const manifest = loadManagedManifest();

  const nextManaged: Record<AgentId, Set<string>> = {
    gemini: new Set(),
    claude: new Set(),
    codex: new Set(),
  };

  syncJsonAgent(
    "gemini",
    join(HOME, ".gemini", "config"),
    join(HOME, ".gemini", "config", "mcp_config.json"),
    servers,
    new Set(manifest.managed.gemini),
    nextManaged.gemini,
  );
  syncJsonAgent(
    "claude",
    join(HOME, ".claude"),
    join(HOME, ".claude.json"),
    servers,
    new Set(manifest.managed.claude),
    nextManaged.claude,
  );
  syncCodexAgent(
    join(HOME, ".codex"),
    join(HOME, ".codex", "config.toml"),
    servers,
    new Set(manifest.managed.codex),
    nextManaged.codex,
  );

  if (conflicts > 0) {
    console.error(`mcp-sync: ${conflicts} conflict(s) found; refusing to overwrite.`);
    process.exit(1);
  }

  if (CHECK_ONLY && drift > 0) {
    console.error(`mcp-sync: out of sync (${drift} change(s) needed).`);
    process.exit(1);
  }

  const nextManifest: ManagedManifest = {
    version: 1,
    managed: {
      gemini: [...nextManaged.gemini].sort(),
      claude: [...nextManaged.claude].sort(),
      codex: [...nextManaged.codex].sort(),
    },
  };

  if (!DRY_RUN && stableJson(manifest) !== stableJson(nextManifest)) {
    atomicWrite(MANAGED_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`, 0o644);
  }
}

main();
