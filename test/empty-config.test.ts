// A target config that exists but holds no content (0 bytes, or whitespace only) is treated like
// an absent one: flyingrobots/agent-hub#54. Oracle: docs/topics/mcp/README.md, "Strict JSON refusals".
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeOutput } from "./jsonl.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_BIN = process.env.AGENT_HUB_BINARY || join(REPO_ROOT, "bin", "sync-agents");
const tempRoots: string[] = [];

type JsonTarget = {
  name: "claude" | "antigravity" | "cursor" | "opencode";
  config: (home: string) => string;
  servers: (doc: Record<string, unknown>) => unknown;
};

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

const JSON_TARGETS: JsonTarget[] = [
  { name: "claude", config: (h) => join(h, ".claude.json"), servers: (d) => field(d, "mcpServers") },
  {
    name: "antigravity",
    config: (h) => join(h, ".gemini", "config", "mcp_config.json"),
    servers: (d) => field(d, "mcpServers"),
  },
  { name: "cursor", config: (h) => join(h, ".cursor", "mcp.json"), servers: (d) => field(d, "mcpServers") },
  {
    name: "opencode",
    config: (h) => join(h, ".config", "opencode", "opencode.json"),
    servers: (d) => field(field(d, "mcp"), "servers"),
  },
];

const EMPTY_CONTENTS: Array<[string, string]> = [
  ["0 bytes", ""],
  ["one newline", "\n"],
  ["spaces, tab and newlines", "  \n\t\r\n"],
];

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-empty-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "mcp", "srv"), { recursive: true });
  writeFileSync(join(hub, "AGENTS.md"), "# Rules\n");
  writeFileSync(join(hub, "mcp", "srv", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/echo", args: ["hi"] } }));
  for (const dir of [".claude", ".gemini/config", ".cursor", ".config/opencode"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  return { home, env };
}

function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawnSync([SYNC_BIN, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, ...decodeOutput(proc.stdout.toString(), proc.stderr.toString()) };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("a target JSON config with no content (#54)", () => {
  test("a JSON target config with no content is synced like an absent one, for every JSON target", () => {
    const problems: string[] = [];
    let cases = 0;
    for (const target of JSON_TARGETS) {
      for (const [label, content] of EMPTY_CONTENTS) {
        cases++;
        const where = `${target.name}, ${label}`;
        const { home, env } = makeSandbox();
        const configPath = target.config(home);
        writeFileSync(configPath, content);

        const result = run(["--targets", `${target.name}:mcp`], env);

        if (result.exitCode !== 0) {
          problems.push(`${where}: sync exited ${result.exitCode}: ${result.stderr}`);
          continue;
        }
        const doc: unknown = JSON.parse(readFileSync(configPath, "utf8"));
        if (field(target.servers(doc as Record<string, unknown>), "srv") === undefined) {
          problems.push(`${where}: the server is missing from the written config`);
        }
        const check = run(["--check", "--targets", `${target.name}:mcp`], env);
        if (check.exitCode !== 0) problems.push(`${where}: --check exited ${check.exitCode}`);
      }
    }
    expect(cases).toBe(JSON_TARGETS.length * EMPTY_CONTENTS.length);
    expect(problems).toEqual([]);
  });

  test("a truncated JSON target config is still refused and left as it was, for every JSON target", () => {
    const truncated = '{ "mcpServers": ';
    const problems: string[] = [];
    for (const target of JSON_TARGETS) {
      const { home, env } = makeSandbox();
      const configPath = target.config(home);
      writeFileSync(configPath, truncated);

      const result = run(["--targets", `${target.name}:mcp`], env);

      if (result.exitCode !== 1) problems.push(`${target.name}: exited ${result.exitCode}, expected 1`);
      if (!result.stderr.includes("invalid JSON")) problems.push(`${target.name}: no "invalid JSON" in: ${result.stderr}`);
      if (readFileSync(configPath, "utf8") !== truncated) problems.push(`${target.name}: the config was changed`);
    }
    expect(JSON_TARGETS.length).toBe(4);
    expect(problems).toEqual([]);
  });

  test("import plans without error when an agent's config has no content", () => {
    const { home, env } = makeSandbox();
    writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), "");

    const result = run(["import", "--from", "antigravity", "--only", "mcp"], env);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
