/**
 * Centralized adapter registry for link targets and MCP compilation targets.
 * Consolidates per-agent paths, default file modes, transport capabilities,
 * compilation rules, and comparable normalizers.
 */
import { isAbsolute, join, sep } from "node:path";
import { ENV_NAME, exactEnvRef, hasEnvRef, mapSpecRefs, specFields, validateSpecRefs } from "./env-refs.ts";
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
  /** When set, servers live one level down, at `<rootKey>.<nestedKey>` (OpenCode: `mcp.servers`). */
  readonly nestedKey?: string;
  /** Keys of `<rootKey>` that are not server names (OpenCode: `servers`, `timeout`). */
  /**
   * Keys of <rootKey> the agent itself uses (OpenCode: servers, timeout). They are legal server
   * names in the nested map; only the previous direct layout needs care with them.
   */
  readonly reservedNames?: readonly string[];
  /** Comparable form used for ledger digests of entries in the previous (direct) layout. */
  readonly legacyNormalizeComparable?: (entry: unknown) => Record<string, unknown>;
  /** Rewrite a previous-layout entry in the current layout's shape (for migration). */
  readonly legacyToCurrent?: (entry: unknown) => Record<string, unknown>;
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

/**
 * The comparable form of an entry in OpenCode's current mcp.servers layout. `enabled` is not a
 * key of that layout, so it is kept: an entry carrying it differs from what agent-hub writes.
 */
export function normalizeOpenCodeComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (copy.disabled === false) delete copy.disabled;
  if (isPlainObject(copy.environment) && Object.keys(copy.environment).length === 0) {
    delete copy.environment;
  }
  if (isPlainObject(copy.headers) && Object.keys(copy.headers).length === 0) {
    delete copy.headers;
  }
  return copy;
}

/** A previous-layout OpenCode entry in the current shape: `enabled` becomes `disabled`. */
export function legacyOpenCodeToCurrent(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (copy.enabled === false) copy.disabled = true;
  delete copy.enabled;
  if (copy.disabled === false) delete copy.disabled;
  if (isPlainObject(copy.environment) && Object.keys(copy.environment).length === 0) {
    delete copy.environment;
  }
  if (isPlainObject(copy.headers) && Object.keys(copy.headers).length === 0) {
    delete copy.headers;
  }
  return copy;
}

/** The comparable form agent-hub used for OpenCode entries before the mcp.servers layout. */
export function normalizeLegacyOpenCodeComparable(entry: unknown): Record<string, unknown> {
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

/** Validate every ${env:...} reference, naming the server and source on failure. */
function checkRefs(spec: McpServerSpec, serverName: string, sourceLabel: string): void {
  try {
    validateSpecRefs(spec);
  } catch (err) {
    throw new Error(`${sourceLabel}: MCP "${serverName}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Codex has no interpolation; it reads variables only through dedicated keys. Compile the exact
 * forms it can express and refuse every other reference:
 * - env K = "${env:K}"            -> env_vars = ["K"] (forwarded from the agent's environment)
 * - Authorization = "Bearer ${env:X}" -> bearer_token_env_var = "X"
 * - header H = "${env:X}"         -> env_http_headers.H = "X"
 */
function compileCodexRefs(
  out: Record<string, unknown>,
  spec: McpServerSpec,
  serverName: string,
  sourceLabel: string,
): void {
  const refuse = (field: string, why: string) => {
    throw new Error(
      `${sourceLabel}: Codex cannot express the \${env:...} reference in ${field} of MCP "${serverName}" (${why}); use a literal, or set overrides.codex.disabled = true`,
    );
  };
  // Only the fields this transport writes: a field Codex never receives cannot mislead it.
  const stdio = out.command !== undefined;
  if (stdio && typeof spec.command === "string" && hasEnvRef(spec.command)) refuse("command", "Codex expands no variables in command");
  if (stdio) {
    (spec.args ?? []).forEach((a, i) => {
      if (hasEnvRef(a)) refuse(`args[${i}]`, "Codex expands no variables in args");
    });
  }
  if (!stdio && typeof spec.url === "string" && hasEnvRef(spec.url)) refuse("url", "Codex expands no variables in url");
  if (out.env && typeof out.env === "object") {
    const env = { ...(out.env as Record<string, string>) };
    const forwarded: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (!hasEnvRef(v)) continue;
      if (exactEnvRef(v) !== k) {
        refuse(
          `env.${k}`,
          ENV_NAME.test(k)
            ? `only env ${k} = "\${env:${k}}", forwarding the same name, is supported`
            : `Codex forwards a variable only under its own name, and "${k}" is not a valid variable name`,
        );
      }
      forwarded.push(k);
      delete env[k];
    }
    if (forwarded.length > 0) {
      if (Object.keys(env).length > 0) out.env = env;
      else delete out.env;
      out.env_vars = forwarded.sort();
    }
  }
  if (out.http_headers && typeof out.http_headers === "object") {
    const headers = { ...(out.http_headers as Record<string, string>) };
    const fromEnv: Record<string, string> = {};
    // Header names are case-insensitive: two spellings of one header cannot both be compiled.
    const lower = Object.keys(headers).map((h) => h.toLowerCase());
    for (const dup of new Set(lower.filter((h, i) => lower.indexOf(h) !== i))) {
      // Authorization is compiled specially, so any second spelling of it is refused; another
      // header only when one of its spellings carries a reference.
      if (dup === "authorization" || Object.entries(headers).some(([h, v]) => h.toLowerCase() === dup && hasEnvRef(v))) {
        refuse(`headers.${dup}`, "the header is set twice under different capitalizations");
      }
    }
    for (const [h, v] of Object.entries(headers)) {
      if (!hasEnvRef(v)) continue;
      const bearer = /^Bearer (\$\{env:[A-Z_][A-Z0-9_]*\})$/.exec(v);
      if (h.toLowerCase() === "authorization" && bearer) {
        out.bearer_token_env_var = exactEnvRef(bearer[1]!);
      } else if (exactEnvRef(v) !== null) {
        fromEnv[h] = exactEnvRef(v)!;
      } else {
        refuse(`headers.${h}`, 'only "Bearer \${env:X}" for Authorization, or a whole-value "\${env:X}", is supported');
      }
      delete headers[h];
    }
    if (Object.keys(fromEnv).length > 0) out.env_http_headers = fromEnv;
    if (Object.keys(headers).length > 0) out.http_headers = headers;
    else delete out.http_headers;
  }
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
      checkRefs(spec, serverName, sourceLabel);
      const written = transport === "stdio" ? /^(command|args\[|env\.)/ : /^(url|headers\.)/;
      const ref = specFields(spec).find(([f, v]) => written.test(f) && hasEnvRef(v));
      if (ref) {
        throw new Error(
          `${sourceLabel}: Antigravity does not expand environment references (\${env:...} in ${ref[0]} of MCP "${serverName}"); use a literal, or set overrides.antigravity.disabled = true`,
        );
      }
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
    compile(transport, rawSpec, serverName, sourceLabel) {
      checkRefs(rawSpec, serverName, sourceLabel);
      // Claude Code expands ${VAR} in command, args, env, url and headers.
      const spec = mapSpecRefs(rawSpec, (name) => `\${${name}}`);
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
      checkRefs(spec, serverName, sourceLabel);
      const out: Record<string, unknown> = {};
      if (transport === "stdio") {
        out.command = spec.command;
        if (spec.args && spec.args.length > 0) out.args = spec.args;
        if (spec.env && Object.keys(spec.env).length > 0) out.env = spec.env;
      } else {
        out.url = spec.url;
        if (spec.headers && Object.keys(spec.headers).length > 0) out.http_headers = spec.headers;
      }
      compileCodexRefs(out, spec, serverName, sourceLabel);
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
    compile(transport, spec, serverName, sourceLabel) {
      // Cursor expands ${env:VAR} itself in command, args, env, url and headers.
      checkRefs(spec, serverName, sourceLabel);
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
    // OpenCode's current layout (https://opencode.ai/config.json: mcp.servers, with the direct
    // mcp.<name> form marked deprecated).
    nestedKey: "servers",
    reservedNames: ["servers", "timeout"],
    legacyNormalizeComparable: normalizeLegacyOpenCodeComparable,
    legacyToCurrent: legacyOpenCodeToCurrent,
    defaultMode: 0o600,
    supportedTransports: ["stdio", "http", "sse"],
    rootDir: (_homeDir, configBase) => join(configBase, "opencode"),
    configPath: (_homeDir, configBase) => join(configBase, "opencode", "opencode.json"),
    compile(transport, rawSpec, serverName, sourceLabel) {
      checkRefs(rawSpec, serverName, sourceLabel);
      // OpenCode substitutes {env:VAR} inside any string of its config.
      const spec = mapSpecRefs(rawSpec, (name) => `{env:${name}}`);
      if (transport === "stdio") {
        const out: Record<string, unknown> = {
          type: "local",
          command: [spec.command!, ...(spec.args ?? [])],
        };
        if (spec.env && Object.keys(spec.env).length > 0) out.environment = spec.env;
        return out;
      }
      const out: Record<string, unknown> = {
        type: "remote",
        url: spec.url,
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
