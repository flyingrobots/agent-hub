import { afterEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_USAGE } from "../src/cli.ts";
import { SCHEMAS } from "../src/output.ts";
import { decodeOutput, decodeStream } from "./jsonl.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENGINE = join(REPO_ROOT, "src", "cli.ts");
const MCP_SYNC = join(REPO_ROOT, "src", "mcp-sync.ts");
const WRAPPER = join(REPO_ROOT, "bin", "sync-agents");

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-jsonl-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "skills", "demo"), { recursive: true });
  writeFileSync(join(hub, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
  writeFileSync(join(hub, "AGENTS.md"), "# rules\n");
  mkdirSync(join(hub, "mcp", "alpha"), { recursive: true });
  writeFileSync(join(hub, "mcp", "alpha", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/alpha" } }));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  return { home, hub, env };
}

function raw(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("JSON Lines output contract (flyingrobots/agent-hub#5)", () => {
  test("every file in schemas/ is a registered message schema, and every registered schema is a file", () => {
    const files = readdirSync(join(REPO_ROOT, "schemas"))
      .filter((f) => f.endsWith(".schema.json"))
      .map((f) => f.replace(/\.schema\.json$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(SCHEMAS).sort());
    for (const id of files) {
      const s = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", `${id}.schema.json`), "utf8"));
      expect(s.title).toBe(id);
      expect(s.properties._schema.properties.id.const).toBe(id);
      expect(s.properties._schema.properties.version.const).toBe(s["x-schema-version"]);
      expect(s.required).toEqual(expect.arrayContaining(["_schema", "kind", "run_id", "message"]));
    }
  });

  test("--schema prints one valid line per declared schema, and each printed schema compiles", () => {
    const { env } = sandbox();
    const r = raw(["bun", ENGINE, "--schema"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const { events } = decodeStream(r.stdout, "stdout");
    expect(events.map((e) => e.schema_id)).toEqual(Object.keys(SCHEMAS));
    const ajv = new Ajv2020({ strict: false });
    for (const e of events) expect(() => ajv.compile(e.schema as object)).not.toThrow();
  });

  test("--help is one agent_hub.help line naming every schema, from the engine, mcp-sync and the wrapper", () => {
    const { env } = sandbox();
    for (const cmd of [["bun", ENGINE, "--help"], ["bun", MCP_SYNC, "--help"], [WRAPPER, "--help"]]) {
      const r = raw(cmd, env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      const { events } = decodeStream(r.stdout, "stdout");
      expect(events.length).toBe(1);
      expect(events[0]!._schema.id).toBe("agent_hub.help");
      expect(events[0]!.schemas).toEqual(Object.keys(SCHEMAS));
    }
  });

  test("the wrapper's help text is the engine's help text", () => {
    const { env } = sandbox();
    const { events } = decodeStream(raw([WRAPPER, "--help"], env).stdout, "stdout");
    expect(events[0]!.usage).toBe(CLI_USAGE);
  });

  test("--human prints prose, not JSON, for help, print-dir and a sync", () => {
    const { hub, env } = sandbox();
    const help = raw([WRAPPER, "--help", "--human"], env);
    expect(help.stdout.startsWith("Usage: sync-agents")).toBe(true);
    const dir = raw([WRAPPER, "--print-dir", "--dir", hub, "--humanize"], env);
    expect(dir.stdout).toBe(`${hub}\n`);
    const sync = raw(["bun", ENGINE, "--dir", hub, "--human", "--targets", "claude"], env);
    expect(sync.exitCode).toBe(0);
    for (const line of sync.stdout.split("\n").filter(Boolean)) expect(line.startsWith("{")).toBe(false);
    expect(sync.stdout).toContain("[sync]");
  });

  test("a usage error is one agent_hub.error line with code usage on stderr, exit 2, nothing on stdout", () => {
    const { env } = sandbox();
    for (const cmd of [["bun", ENGINE, "--bogus"], [WRAPPER, "--dir"]]) {
      const r = raw(cmd, env);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      const { events } = decodeStream(r.stderr, "stderr");
      expect(events.length).toBe(1);
      expect(events[0]!._schema.id).toBe("agent_hub.error");
      expect(events[0]!.code).toBe("usage");
    }
  });

  test("apply, check, dry-run, explain and a conflict all print only valid lines sharing one run_id per run", () => {
    const { home, hub, env } = sandbox();
    const runs: Array<{ args: string[]; exit: number; kinds: string[] }> = [
      { args: ["--dry-run"], exit: 0, kinds: ["op"] },
      { args: [], exit: 0, kinds: ["op", "summary"] },
      { args: ["--check"], exit: 0, kinds: ["summary"] },
      { args: ["--explain"], exit: 0, kinds: ["op"] },
    ];
    for (const run of runs) {
      const r = raw(["bun", ENGINE, "--dir", hub, "--targets", "claude", ...run.args], env);
      expect(r.exitCode).toBe(run.exit);
      const { events } = decodeOutput(r.stdout, r.stderr);
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map((e) => e.run_id)).size).toBe(1);
      for (const k of run.kinds) expect(events.map((e) => e.kind)).toContain(k);
    }
    // A conflict: an unmanaged, different entry where agent-hub would write alpha.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { beta: { command: "/bin/b" } } }));
    writeFileSync(join(hub, "mcp", "alpha", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/alpha2" } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { alpha: { command: "/bin/user" } } }));
    const c = raw(["bun", ENGINE, "--dir", hub, "--targets", "claude"], env);
    expect(c.exitCode).toBe(1);
    const { events } = decodeOutput(c.stdout, c.stderr);
    const conflict = events.find((e) => e.kind === "conflict");
    expect(conflict).toBeDefined();
    expect((conflict!.op as { status: string }).status).toBe("conflict");
    expect(events.find((e) => e.kind === "summary")!.status).toBe("conflicts");
  });

  test("two runs carry different run_ids", () => {
    const { hub, env } = sandbox();
    const a = decodeStream(raw(["bun", ENGINE, "--dir", hub, "--print-dir"], env).stdout, "stdout").events[0]!;
    const b = decodeStream(raw(["bun", ENGINE, "--dir", hub, "--print-dir"], env).stdout, "stdout").events[0]!;
    expect(a.run_id).not.toBe(b.run_id);
  });

  test("a wrapper message with control characters is still one valid JSON line", () => {
    const { home, env } = sandbox();
    const weird = `${home}/a\u0001b"q\\z\ttab`;
    const r = raw([WRAPPER, "--print-dir", "--dir", weird], env);
    expect(r.exitCode).toBe(0);
    const { events } = decodeStream(r.stdout, "stdout");
    expect(events[0]!.hub).toBe(weird);
  });
});
