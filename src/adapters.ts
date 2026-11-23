/**
 * Centralized adapter registry for link targets and MCP compilation targets.
 * Consolidates per-agent paths, default file modes, transport capabilities,
 * compilation rules, and comparable normalizers.
 */
import { isAbsolute, join, sep } from "node:path";
import { isPlainObject } from "./paths.ts";
import { normalizeCodexComparable } from "./toml-edit.ts";
import type { AgentId, McpServerSpec, McpTransport } from "./types.ts";

export type LinkTargetDef = {
  readonly targetId: AgentId;
  /** Root relative to HOME, or to the XDG config base (`$XDG_CONFIG_HOME` or `~/.config`). */
  readonly base?: "home" | "config";
  readonly rootRel: string;
  readonly rulesRel: string | null;
  readonly skillsRel: string | null;
};

export const LINK_TARGETS: readonly LinkTargetDef[] = [
  { targetId: "codex", rootRel: ".codex", rulesRel: "AGENTS.md", skillsRel: "skills" },
  { targetId: "claude", rootRel: ".claude", rulesRel: "CLAUDE.md", skillsRel: "skills" },
  { targetId: "antigravity", rootRel: ".gemini", rulesRel: "GEMINI.md", skillsRel: "skills" },
  { targetId: "antigravity", rootRel: ".gemini/config", rulesRel: "AGENTS.md", skillsRel: null },
  // OpenCode roots its global config at ${XDG_CONFIG_HOME:-~/.config}/opencode
  // (anomalyco/opencode packages/util/src/global-roots.ts).
  { targetId: "opencode", base: "config", rootRel: "opencode", rulesRel: "AGENTS.md", skillsRel: "skills" },
  { targetId: "cursor", rootRel: ".cursor", rulesRel: "AGENTS.md", skillsRel: "skills" },
] as const;

/**
 * The XDG config base: `$XDG_CONFIG_HOME` when it is an absolute path, else `~/.config`. A relative
 * value is ignored, as the XDG Base Directory spec requires. The value is used as spelled; two
 * spellings of one directory (a symlinked `~/.config`, an aliased HOME) are reconciled where
 * ownership is decided, by comparing physical paths (see physicalPath).
 */
export function xdgConfigBase(homeDir: string, xdgConfigHome?: string): string {
  if (xdgConfigHome && isAbsolute(xdgConfigHome)) return xdgConfigHome;
  return join(homeDir, ".config");
}

/** Absolute root directory of a link target. */
export function linkTargetRoot(target: LinkTargetDef, homeDir: string, configBase: string): string {
  return join(target.base === "config" ? configBase : homeDir, target.rootRel);
}

/**
 * Determine which target owns a recorded link destination under the current HOME (OpenCode: under the current XDG config base), so a
 * scoped run never prunes an excluded target's links.
 *
 * Ownership is recognized only for an exact layout path: a target's rules file
 * (`<root>/<rulesRel>`) or a direct child of its skills directory (`<root>/<skillsRel>/<name>`).
 * A prefix match is not enough: a record written under an earlier HOME nested inside another
 * target's root (for example HOME was `~/.cursor`, leaving `~/.cursor/.claude/skills/x`) would
 * otherwise be attributed to the wrong target. Because no two targets' root directories share a
 * basename, an exact layout match is unambiguous. Anything else returns null, and scoped runs
 * keep records they cannot attribute.
 */
export function resolveLinkTargetId(
  dstPath: string,
  homeDir: string,
  configBase: string = join(homeDir, ".config"),
): AgentId | null {
  for (const target of LINK_TARGETS) {
    const rootAbs = linkTargetRoot(target, homeDir, configBase);
    if (target.rulesRel && dstPath === join(rootAbs, target.rulesRel)) return target.targetId;
    if (target.skillsRel) {
      const skillsAbs = join(rootAbs, target.skillsRel);
      const name = dstPath.startsWith(`${skillsAbs}${sep}`) ? dstPath.slice(skillsAbs.length + 1) : "";
      if (name.length > 0 && !name.includes(sep)) return target.targetId;
    }
  }
  return null;
}

export type McpAdapterDef = {
  readonly id: AgentId;
  readonly label: string;
  readonly format: "json" | "toml";
  readonly rootKey?: "mcpServers" | "mcp";
  readonly defaultMode: number;
  readonly supportedTransports: readonly McpTransport[];
  readonly rootDir: (homeDir: string, configBase: string) => string;
  readonly configPath: (homeDir: string, configBase: string) => string;
  readonly compile: (
    transport: McpTransport,
    spec: McpServerSpec,
    serverName: string,
    sourceLabel: string,
  ) => Record<string, unknown>;
  readonly normalizeComparable: (entry: unknown) => Record<string, unknown>;
};

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

export function normalizeCursorComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (copy.command && !copy.type) copy.type = "stdio";
  if (Array.isArray(copy.args) && copy.args.length === 0) delete copy.args;
  if (isPlainObject(copy.env) && Object.keys(copy.env).length === 0) delete copy.env;
  if (isPlainObject(copy.headers) && Object.keys(copy.headers).length === 0) delete copy.headers;
  return copy;
}

export function normalizeOpenCodeComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (copy.enabled === undefined) copy.enabled = true;
  if (isPlainObject(copy.environment) && Object.keys(copy.environment).length === 0) {
    delete copy.environment;
  }
  if (isPlainObject(copy.headers) && Object.keys(copy.headers).length === 0) {
    delete copy.headers;
  }
  return copy;
}

export const MCP_ADAPTERS: readonly McpAdapterDef[] = [
  {
    id: "antigravity",
    label: "Antigravity",
    format: "json",
    rootKey: "mcpServers",
    defaultMode: 0o644,
    supportedTransports: ["stdio", "http"],
    rootDir: (homeDir) => join(homeDir, ".gemini", "config"),
    configPath: (homeDir) => join(homeDir, ".gemini", "config", "mcp_config.json"),
    compile(transport, spec, serverName, sourceLabel) {
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
    },
    normalizeComparable: normalizeAntigravityComparable,
  },
  {
    id: "claude",
    label: "Claude Code",
    format: "json",
    rootKey: "mcpServers",
    defaultMode: 0o600,
    supportedTransports: ["stdio", "http", "sse"],
    rootDir: (homeDir) => join(homeDir, ".claude"),
    configPath: (homeDir) => join(homeDir, ".claude.json"),
    compile(transport, spec) {
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
        type: transport,
        url: spec.url,
      };
      if (spec.headers && Object.keys(spec.headers).length > 0) out.headers = spec.headers;
      return out;
    },
    normalizeComparable: normalizeClaudeComparable,
  },
  {
    id: "codex",
    label: "Codex",
    format: "toml",
    defaultMode: 0o600,
    supportedTransports: ["stdio", "http"],
    rootDir: (homeDir) => join(homeDir, ".codex"),
    configPath: (homeDir) => join(homeDir, ".codex", "config.toml"),
    compile(transport, spec, serverName, sourceLabel) {
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
    },
    normalizeComparable: normalizeCodexComparable,
  },
  {
    id: "cursor",
    label: "Cursor",
    format: "json",
    rootKey: "mcpServers",
    defaultMode: 0o600,
    supportedTransports: ["stdio", "http", "sse"],
    rootDir: (homeDir) => join(homeDir, ".cursor"),
    configPath: (homeDir) => join(homeDir, ".cursor", "mcp.json"),
    compile(transport, spec) {
      if (transport === "stdio") {
        const out: Record<string, unknown> = {
          type: "stdio",
          command: spec.command,
        };
        if (spec.args && spec.args.length > 0) out.args = spec.args;
        if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
        return out;
      }
      const out: Record<string, unknown> = {
        url: spec.url,
      };
      if (spec.headers && Object.keys(spec.headers).length > 0) out.headers = spec.headers;
      return out;
    },
    normalizeComparable: normalizeCursorComparable,
  },
  {
    id: "opencode",
    label: "OpenCode",
    format: "json",
    rootKey: "mcp",
    defaultMode: 0o600,
    supportedTransports: ["stdio", "http", "sse"],
    rootDir: (_homeDir, configBase) => join(configBase, "opencode"),
    configPath: (_homeDir, configBase) => join(configBase, "opencode", "opencode.json"),
    compile(transport, spec) {
      if (transport === "stdio") {
        const out: Record<string, unknown> = {
          type: "local",
          command: [spec.command!, ...(spec.args ?? [])],
          enabled: true,
        };
        if (spec.env && Object.keys(spec.env).length > 0) out.environment = spec.env;
        return out;
      }
      const out: Record<string, unknown> = {
        type: "remote",
        url: spec.url,
        enabled: true,
      };
      if (spec.headers && Object.keys(spec.headers).length > 0) out.headers = spec.headers;
      return out;
    },
    normalizeComparable: normalizeOpenCodeComparable,
  },
] as const;

export const MCP_ADAPTER_BY_ID: Record<AgentId, McpAdapterDef> = {
  antigravity: MCP_ADAPTERS[0]!,
  claude: MCP_ADAPTERS[1]!,
  codex: MCP_ADAPTERS[2]!,
  cursor: MCP_ADAPTERS[3]!,
  opencode: MCP_ADAPTERS[4]!,
};
