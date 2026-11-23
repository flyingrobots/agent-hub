// Machine overrides: per-machine variation of hub MCP servers, read from
// ${XDG_CONFIG_HOME}/agent-hub/machine.json (flyingrobots/agent-hub#58).
// Oracle: docs/adr/0001-machine-overrides-live-outside-the-hub.md and docs/topics/mcp/README.md.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeOutput, type DecodedEvent } from "./jsonl.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_BIN = process.env.AGENT_HUB_BINARY || join(REPO_ROOT, "bin", "sync-agents");
const tempRoots: string[] = [];

type Sandbox = {
  home: string;
  hub: string;
  env: Record<string, string>;
  machinePath: string;
  hubServerPath: string;
};

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** A hub with one stdio server `srv`, and Claude and Codex installed. */
function makeSandbox(hubServer: unknown = { mcp: { command: "/bin/echo", args: ["hub"] } }): Sandbox {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-machine-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "mcp", "srv"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
  writeFileSync(join(hub, "AGENTS.md"), "# Rules\n");
  const hubServerPath = join(hub, "mcp", "srv", "mcp.json");
  writeFileSync(hubServerPath, `${JSON.stringify(hubServer, null, 2)}\n`);
  return {
    home,
    hub,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local", "state") },
    machinePath: join(home, ".config", "agent-hub", "machine.json"),
    hubServerPath,
  };
}

function writeMachine(sb: Sandbox, doc: unknown): void {
  writeFileSync(sb.machinePath, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
}

function run(sb: Sandbox, args: string[], cwd?: string) {
  const proc = Bun.spawnSync([SYNC_BIN, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...sb.env },
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd ? { cwd } : {}),
  });
  return { exitCode: proc.exitCode, ...decodeOutput(proc.stdout.toString(), proc.stderr.toString()) };
}

const mcpOnly = ["--targets", "claude:mcp,codex:mcp"];

function claudeServer(sb: Sandbox): unknown {
  const path = join(sb.home, ".claude.json");
  if (!existsSync(path)) return undefined;
  return field(field(JSON.parse(readFileSync(path, "utf8")), "mcpServers"), "srv");
}

function codexServer(sb: Sandbox): unknown {
  const path = join(sb.home, ".codex", "config.toml");
  if (!existsSync(path)) return undefined;
  return field(field(Bun.TOML.parse(readFileSync(path, "utf8")), "mcp_servers"), "srv");
}

function summary(events: DecodedEvent[]): DecodedEvent {
  const found = events.filter((e) => e._schema.id === "agent_hub.summary");
  expect(found.length).toBe(1);
  return found[0]!;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("machine overrides (#58)", () => {
  test("a machine override changes what every target receives and leaves the hub file as it was", () => {
    const sb = makeSandbox();
    const hubBefore = readFileSync(sb.hubServerPath, "utf8");
    writeMachine(sb, { mcp: { srv: { mcp: { command: "/bin/cat" } } } });

    const result = run(sb, mcpOnly);

    expect(result.exitCode).toBe(0);
    expect(field(claudeServer(sb), "command")).toBe("/bin/cat");
    expect(field(codexServer(sb), "command")).toBe("/bin/cat");
    expect(field(claudeServer(sb), "args")).toEqual(["hub"]);
    expect(readFileSync(sb.hubServerPath, "utf8")).toBe(hubBefore);
  });

  test("layers apply in order: hub base, hub target override, machine base, machine target override", () => {
    const sb = makeSandbox({
      mcp: { command: "/bin/echo", env: { MODE: "hub", KEEP: "hub" } },
      overrides: { codex: { env: { MODE: "hub-codex" } } },
    });
    writeMachine(sb, {
      mcp: { srv: { mcp: { env: { MODE: "machine" } }, overrides: { codex: { env: { MODE: "machine-codex" } } } } },
    });

    expect(run(sb, mcpOnly).exitCode).toBe(0);

    expect(field(claudeServer(sb), "env")).toEqual({ KEEP: "hub", MODE: "machine" });
    expect(field(codexServer(sb), "env")).toEqual({ KEEP: "hub", MODE: "machine-codex" });
  });

  test("a machine override that disables a server removes the owned entry from every target", () => {
    const sb = makeSandbox();
    expect(run(sb, mcpOnly).exitCode).toBe(0);
    expect(claudeServer(sb)).toBeDefined();
    expect(codexServer(sb)).toBeDefined();
    writeMachine(sb, { mcp: { srv: { mcp: { disabled: true } } } });

    expect(run(sb, mcpOnly).exitCode).toBe(0);

    expect(claudeServer(sb)).toBeUndefined();
    expect(codexServer(sb)).toBeUndefined();
  });

  test("a machine override that disables a server for one target omits it there only", () => {
    const sb = makeSandbox();
    writeMachine(sb, { mcp: { srv: { overrides: { codex: { disabled: true } } } } });

    expect(run(sb, mcpOnly).exitCode).toBe(0);

    expect(claudeServer(sb)).toBeDefined();
    expect(codexServer(sb)).toBeUndefined();
  });

  test("an unowned entry with the name of a server disabled for that target is left alone, even under --force", () => {
    const sb = makeSandbox();
    const codexConfig = join(sb.home, ".codex", "config.toml");
    const personal = '[mcp_servers.srv]\ncommand = "/usr/bin/true"\nargs = ["personal"]\n';
    writeFileSync(codexConfig, personal);
    // Without a machine override the clash is a conflict and nothing is written.
    expect(run(sb, mcpOnly).exitCode).toBe(1);
    expect(readFileSync(codexConfig, "utf8")).toBe(personal);
    writeMachine(sb, { mcp: { srv: { overrides: { codex: { disabled: true } } } } });

    const plain = run(sb, mcpOnly);
    const forced = run(sb, [...mcpOnly, "--force"]);

    expect(plain.exitCode).toBe(0);
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(codexConfig, "utf8")).toBe(personal);
    expect(claudeServer(sb)).toBeDefined();
    expect(run(sb, ["--check", ...mcpOnly]).exitCode).toBe(0);
  });

  test("--check is in sync with the hub as modified on this machine, and every summary counts the overrides in effect", () => {
    const sb = makeSandbox();
    writeMachine(sb, { mcp: { srv: { overrides: { codex: { disabled: true } } } } });

    const applied = run(sb, mcpOnly);
    const check = run(sb, ["--check", ...mcpOnly]);

    expect(check.exitCode).toBe(0);
    for (const res of [applied, check]) {
      const line = summary(res.events);
      expect(line.machine_overrides).toBe(1);
      expect(String(line.message)).toContain("1 machine override(s) in effect.");
    }
  });

  test("--dry-run and --explain name the machine override file for a server it changes or omits", () => {
    const sb = makeSandbox();
    writeMachine(sb, { mcp: { srv: { mcp: { command: "/bin/cat" }, overrides: { codex: { disabled: true } } } } });

    const dryRun = run(sb, ["--dry-run", ...mcpOnly]);
    const explain = run(sb, ["--explain", ...mcpOnly]);

    const reasons = (events: DecodedEvent[]) =>
      events
        .filter((e) => e._schema.id === "agent_hub.op" && String(field(e.op, "destination")).endsWith("#srv"))
        .map((e) => String(field(e.op, "reason")));
    const planned = reasons(dryRun.events);
    expect(planned.length).toBe(1); // Claude's mcp-add; Codex's omitted server is not a change
    expect(planned[0]).toContain(`changed by a machine override in ${sb.machinePath}`);
    const explained = reasons(explain.events);
    expect(explained.length).toBe(2);
    expect(explained.filter((r) => r.includes(`changed by a machine override in ${sb.machinePath}`)).length).toBe(1);
    expect(explained.filter((r) => r.includes(`omitted by a machine override in ${sb.machinePath}`)).length).toBe(1);
  });

  test("a machine override for a server the hub does not define is a warning and changes nothing", () => {
    const sb = makeSandbox();
    writeMachine(sb, { mcp: { ghost: { mcp: { command: "/bin/cat" } } } });

    const result = run(sb, mcpOnly);

    expect(result.exitCode).toBe(0);
    const warnings = result.events.filter((e) => e._schema.id === "agent_hub.warning");
    expect(warnings.map((w) => [w.code, w.server, w.source])).toEqual([["machine_override_unused", "ghost", sb.machinePath]]);
    expect(field(field(JSON.parse(readFileSync(join(sb.home, ".claude.json"), "utf8")), "mcpServers"), "ghost")).toBeUndefined();
    expect(field(claudeServer(sb), "command")).toBe("/bin/echo");
    expect(summary(result.events).machine_overrides).toBeUndefined();
  });

  test("an empty machine override file behaves like none", () => {
    const problems: string[] = [];
    for (const doc of [{}, { mcp: {} }]) {
      const sb = makeSandbox();
      writeMachine(sb, doc);
      const result = run(sb, mcpOnly);
      const line = summary(result.events);
      if (result.exitCode !== 0) problems.push(`${JSON.stringify(doc)}: exit ${result.exitCode}`);
      if (line.machine_overrides !== undefined) problems.push(`${JSON.stringify(doc)}: summary counts overrides`);
      if (field(claudeServer(sb), "command") !== "/bin/echo") problems.push(`${JSON.stringify(doc)}: hub server not written`);
    }
    expect(problems).toEqual([]);
  });

  test("a malformed machine override file fails the run, names the file and writes nothing", () => {
    const malformed: Array<[string, unknown]> = [
      ["not JSON", "{ nope"],
      ["not an object", "[]"],
      ["an unknown top-level key", { servers: {} }],
      ["mcp not an object", { mcp: [] }],
      ["a server that is not an object", { mcp: { srv: "off" } }],
      ["an unknown key in a server", { mcp: { srv: { disabled: true } } }],
      ["an unknown target", { mcp: { srv: { overrides: { gemini: { disabled: true } } } } }],
      ["an unknown spec field", { mcp: { srv: { mcp: { cmd: "/bin/cat" } } } }],
      ["extra at the machine base", { mcp: { srv: { mcp: { extra: { timeout: 1 } } } } }],
      ["an invalid server name", { mcp: { "../x": { mcp: { disabled: true } } } }],
    ];
    const problems: string[] = [];
    for (const [label, doc] of malformed) {
      const sb = makeSandbox();
      writeMachine(sb, doc);
      const result = run(sb, mcpOnly);
      const errors = result.events.filter((e) => e._schema.id === "agent_hub.error");
      if (result.exitCode !== 1) problems.push(`${label}: exit ${result.exitCode}`);
      if (errors.length !== 1 || errors[0]!.code !== "config") problems.push(`${label}: expected one config error`);
      if (!result.stderr.includes(sb.machinePath)) problems.push(`${label}: the file is not named in: ${result.stderr}`);
      if (existsSync(join(sb.home, ".claude.json"))) problems.push(`${label}: a target was written`);
    }
    expect(malformed.length).toBe(10);
    expect(problems).toEqual([]);
  });

  test("a plaintext secret in a machine override refuses the run and names the machine override", () => {
    const sb = makeSandbox();
    writeMachine(sb, { mcp: { srv: { mcp: { env: { API_KEY: "sk-live-0123456789abcdef0123456789abcdef" } } } } });

    const result = run(sb, mcpOnly);

    expect(result.exitCode).toBe(1);
    const warnings = result.events.filter((e) => e._schema.id === "agent_hub.warning");
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(w.code).toBe("plaintext_secret");
      expect(String(w.source)).toContain(sb.machinePath);
    }
    expect(existsSync(join(sb.home, ".claude.json"))).toBe(false);
  });

  test("pull finds nothing to pull when an agent's entry differs from the hub only by a machine override", () => {
    const sb = makeSandbox();
    const hubBefore = readFileSync(sb.hubServerPath, "utf8");
    writeMachine(sb, { mcp: { srv: { mcp: { command: "/bin/cat" } } } });
    expect(run(sb, mcpOnly).exitCode).toBe(0);
    expect(field(claudeServer(sb), "command")).toBe("/bin/cat");

    const result = run(sb, ["pull", "--from", "claude", "mcp/srv"]);

    expect(result.exitCode).toBe(0);
    expect(summary(result.events).status).toBe("in_sync");
    expect(readFileSync(sb.hubServerPath, "utf8")).toBe(hubBefore);
  });

  test("project mode ignores machine overrides", () => {
    const sb = makeSandbox();
    const repo = join(sb.home, "repo");
    mkdirSync(join(repo, ".agents", "mcp", "srv"), { recursive: true });
    writeFileSync(join(repo, ".agents", "mcp", "srv", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/echo" } }));
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    writeMachine(sb, { mcp: { srv: { mcp: { disabled: true } } } });

    const result = run(sb, ["--project", "--dir", repo]);

    expect(result.exitCode).toBe(0);
    const written: unknown = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
    expect(field(field(field(written, "mcpServers"), "srv"), "command")).toBe("/bin/echo");
    expect(summary(result.events).machine_overrides).toBeUndefined();
  });
});
