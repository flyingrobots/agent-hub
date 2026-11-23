/**
 * Machine overrides: per-machine variation of MCP servers the hub defines, kept outside the hub
 * in `${XDG_CONFIG_HOME:-~/.config}/agent-hub/machine.json` (docs/adr/0001).
 *
 * The file maps a hub server name to a document of the same shape as that server's own
 * `mcp.json`: `mcp` (applies to every target on this machine) and `overrides.<target>`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSpecSnippet, SERVER_NAME_RE } from "./mcp.ts";
import { isPlainObject, parseJsonFile } from "./paths.ts";
import { ALL_AGENTS, type AgentId, type McpServerSpec } from "./types.ts";

/** One layer of a machine override, with the label a message uses to name where it came from. */
export type MachineLayer = { spec: McpServerSpec; label: string };

export type MachineServerOverride = {
  /** Applies to every target on this machine. */
  base?: MachineLayer;
  /** Applies to one target on this machine, after `base`. */
  targets: Partial<Record<AgentId, MachineLayer>>;
};

export type MachineOverrides = {
  /** The file the overrides were read from. */
  path: string;
  servers: ReadonlyMap<string, MachineServerOverride>;
};

export function machineOverridesPath(configBase: string): string {
  return join(configBase, "agent-hub", "machine.json");
}

function isAgentId(key: string): key is AgentId {
  return (ALL_AGENTS as readonly string[]).includes(key);
}

/**
 * Read and validate the machine override file. Returns null when there is none. Throws, naming
 * the file, when it is not strict JSON or not of the expected shape: a run that reads machine
 * overrides must not continue on a guess about what this machine wants.
 */
export function loadMachineOverrides(configBase: string): MachineOverrides | null {
  const path = machineOverridesPath(configBase);
  if (!existsSync(path)) return null;

  const doc = parseJsonFile(path);
  if (!isPlainObject(doc)) throw new Error(`${path}: machine.json must contain a JSON object`);
  for (const key of Object.keys(doc)) {
    if (key !== "mcp") throw new Error(`${path}: unknown key "${key}" (expected only "mcp")`);
  }

  const servers = new Map<string, MachineServerOverride>();
  if (doc.mcp === undefined) return { path, servers };
  if (!isPlainObject(doc.mcp)) throw new Error(`${path}: "mcp" must be an object of server names`);

  for (const [name, value] of Object.entries(doc.mcp)) {
    const at = `${path}#mcp.${name}`;
    if (!SERVER_NAME_RE.test(name)) throw new Error(`${path}: invalid MCP server name "${name}"`);
    if (!isPlainObject(value)) throw new Error(`${at}: expected an object with "mcp" and/or "overrides"`);
    for (const key of Object.keys(value)) {
      if (key !== "mcp" && key !== "overrides") {
        throw new Error(`${at}: unknown key "${key}" (expected "mcp" and/or "overrides")`);
      }
    }

    const override: MachineServerOverride = { targets: {} };
    if (value.mcp !== undefined) {
      const label = `${at}.mcp`;
      override.base = { spec: parseSpecSnippet({ mcp: value.mcp }, label), label };
    }
    if (value.overrides !== undefined) {
      if (!isPlainObject(value.overrides)) throw new Error(`${at}: "overrides" must be an object`);
      for (const [target, snippet] of Object.entries(value.overrides)) {
        if (!isAgentId(target)) {
          throw new Error(`${at}.overrides.${target}: unknown target "${target}" (expected one of: ${ALL_AGENTS.join(", ")})`);
        }
        const label = `${at}.overrides.${target}`;
        override.targets[target] = { spec: parseSpecSnippet({ mcp: snippet }, label, true), label };
      }
    }
    servers.set(name, override);
  }
  return { path, servers };
}
