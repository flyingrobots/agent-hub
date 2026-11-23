import { afterEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_USAGE, cliMain } from "../src/cli.ts";
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

  test("--help is an agent_hub.help line then every schema, from the engine, mcp-sync and the wrapper", () => {
    const { env } = sandbox();
    for (const cmd of [["bun", ENGINE, "--help"], ["bun", MCP_SYNC, "--help"], [WRAPPER, "--help"]]) {
      const r = raw(cmd, env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      const { events } = decodeStream(r.stdout, "stdout");
      expect(events[0]!._schema.id).toBe("agent_hub.help");
      expect(events[0]!.schemas).toEqual(Object.keys(SCHEMAS));
      // Then the schema of every message type the command can print, success and error alike.
      expect(events.slice(1).map((e) => e.schema_id)).toEqual(Object.keys(SCHEMAS));
      expect(new Set(events.map((e) => e.run_id)).size).toBe(1);
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

  test("output larger than a pipe buffer reaches a slow reader whole, from the engine and the wrapper", () => {
    const { home, hub, env } = sandbox();
    for (let i = 0; i < 400; i++) {
      mkdirSync(join(hub, "skills", `skill-${i}`), { recursive: true });
      writeFileSync(join(hub, "skills", `skill-${i}`, "SKILL.md"), `---\nname: skill-${i}\ndescription: d\n---\n`);
    }
    for (const cmd of [`bun "${ENGINE}"`, `"${WRAPPER}"`]) {
      const p = Bun.spawnSync(["bash", "-c", `${cmd} --dir "${hub}" --targets claude --dry-run | (sleep 1; cat)`], {
        env,
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = p.stdout.toString();
      expect(text.length).toBeGreaterThan(65536);
      const { events } = decodeStream(text, "stdout");
      expect(events.filter((e) => e.kind === "op").length).toBeGreaterThan(400);
    }
  });

  test("a wrapper --print-dir that cannot resolve the hub is one error line, exit 1, nothing on stdout", () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const { home, env } = sandbox();
    mkdirSync(join(home, "locked", "sub"), { recursive: true });
    chmodSync(join(home, "locked"), 0o000);
    try {
      const r = raw([WRAPPER, "--print-dir", "--dir", join(home, "locked", "sub", "hub")], env);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      const { events } = decodeStream(r.stderr, "stderr");
      expect(events.map((e) => e.kind)).toEqual(["error"]);
    } finally {
      chmodSync(join(home, "locked"), 0o755);
    }
  });

  test("an uncaught throw in the engine becomes one agent_hub.error line with code internal, exit 1", () => {
    // In-process, so it holds on every platform: the sync itself throws.
    const writes: Array<["stdout" | "stderr", string]> = [];
    const orig = { stdout: process.stdout.write, stderr: process.stderr.write };
    for (const name of ["stdout", "stderr"] as const) {
      (process[name] as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
        writes.push([name, String(chunk)]);
        return true;
      };
    }
    let code: number;
    try {
      code = cliMain(["--targets", "claude"], "sync-agents", CLI_USAGE, false, () => {
        throw new Error("boom");
      });
    } finally {
      process.stdout.write = orig.stdout;
      process.stderr.write = orig.stderr;
    }
    expect(code).toBe(1);
    expect(writes.filter(([n]) => n === "stdout")).toEqual([]);
    const { events } = decodeStream(writes.map(([, c]) => c).join(""), "stderr");
    expect(events.length).toBe(1);
    expect(events[0]!.code).toBe("internal");
    expect(String(events[0]!.message)).toContain("boom");
  });

  test("a child process's stderr (tar, unzip) arrives inside a valid error line, never as raw text", () => {
    const { home, hub, env } = sandbox();
    const tarball = join(home, "corrupt.tar.gz");
    writeFileSync(tarball, "this is not a tarball\n");
    const r = raw(["bun", ENGINE, "--dir", hub, "--skill", tarball], { ...env, LC_ALL: "C" });
    expect(r.exitCode).toBe(1);
    const { events } = decodeOutput(r.stdout, r.stderr);
    const err = events.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    expect(String(err!.message)).toContain("tar extract");
    const zip = join(home, "corrupt.zip");
    writeFileSync(zip, "this is not a zip\n");
    const z = raw(["bun", ENGINE, "--dir", hub, "--skill", zip], { ...env, LC_ALL: "C" });
    expect(z.exitCode).toBe(1);
    expect(String(decodeOutput(z.stdout, z.stderr).events.find((e) => e.kind === "error")!.message)).toContain("unzip");
  });

  test("--humanize works in the engine as in the wrapper, and an option value spelled --human is not the flag", () => {
    const { hub, env } = sandbox();
    expect(raw(["bun", ENGINE, "--print-dir", "--dir", hub, "--humanize"], env).stdout).toBe(`${hub}\n`);
    for (const cmd of [["bun", ENGINE], [WRAPPER]]) {
      const r = raw([...cmd, "--print-dir", "--dir", "--human"], env);
      expect(r.exitCode).toBe(0);
      const { events } = decodeStream(r.stdout, "stdout");
      expect(String(events[0]!.hub).endsWith("/--human")).toBe(true);
    }
  });

  test("--schema wins over --help and --print-dir in the wrapper as in the engine", () => {
    const { hub, env } = sandbox();
    for (const cmd of [["bun", ENGINE], [WRAPPER]]) {
      const r = raw([...cmd, "--print-dir", "--dir", hub, "--schema", "--help"], env);
      expect(r.exitCode).toBe(0);
      const { events } = decodeStream(r.stdout, "stdout");
      expect(events.every((e) => e.kind === "schema")).toBe(true);
      expect(events.length).toBe(Object.keys(SCHEMAS).length);
    }
  });

  test("every run past argument parsing ends with one summary or error line: dry-run with changes, explain, check", () => {
    const { hub, env } = sandbox();
    for (const args of [["--dry-run"], ["--explain"], ["--check"]]) {
      const r = raw(["bun", ENGINE, "--dir", hub, "--targets", "claude", ...args], env);
      const { events } = decodeOutput(r.stdout, r.stderr);
      const terminal = events.filter((e) => e.kind === "summary" || e.kind === "error");
      expect(terminal.length).toBe(1);
    }
    const dry = decodeStream(raw(["bun", ENGINE, "--dir", hub, "--targets", "claude", "--dry-run"], env).stdout, "stdout").events;
    expect(dry[dry.length - 1]!.status).toBe("planned");
  });

  test("no test calls src/cli.ts runSync directly; in-process runs go through the checked runSync", () => {
    const offenders = readdirSync(join(REPO_ROOT, "test"))
      .filter((f) => f.endsWith(".ts") && f !== "jsonl.ts")
      .filter((f) => /^import\s*\{[^}]*\brunSync\b[^}]*\}\s*from\s*"\.\.\/src\/cli\.ts"/m.test(readFileSync(join(REPO_ROOT, "test", f), "utf8")));
    expect(offenders).toEqual([]);
  });

  test("a reader that closes the pipe early (head -1) gets a clean exit 0 and no crash text", () => {
    const { home, hub, env } = sandbox();
    for (let i = 0; i < 600; i++) {
      mkdirSync(join(hub, "skills", `s-${i}`), { recursive: true });
      writeFileSync(join(hub, "skills", `s-${i}`, "SKILL.md"), `---\nname: s-${i}\ndescription: d\n---\n`);
    }
    for (const cmd of [`bun "${ENGINE}"`, `"${WRAPPER}"`]) {
      const p = Bun.spawnSync(
        ["bash", "-c", `${cmd} --dir "${hub}" --targets claude --dry-run 2>"${home}/err" | head -1 >/dev/null; echo \${PIPESTATUS[0]}`],
        { env, cwd: home, stdout: "pipe", stderr: "pipe" },
      );
      expect(p.stdout.toString().trim()).toBe("0");
      const err = readFileSync(join(home, "err"), "utf8");
      expect(err).toBe("");
    }
  });

  test("an applied summary counts the changes applied, not the targets written", () => {
    const { hub, env } = sandbox();
    for (const n of ["b1", "b2", "b3", "b4"]) {
      mkdirSync(join(hub, "mcp", n), { recursive: true });
      writeFileSync(join(hub, "mcp", n, "mcp.json"), JSON.stringify({ mcp: { command: `/bin/${n}` } }));
    }
    const r = raw(["bun", ENGINE, "--dir", hub, "--targets", "claude"], env);
    expect(r.exitCode).toBe(0);
    const { events } = decodeOutput(r.stdout, r.stderr);
    const ops = events.filter((e) => e.kind === "op" && e.phase === "sync").length;
    expect(ops).toBeGreaterThan(5);
    expect(events[events.length - 1]!.status).toBe("applied");
    expect(events[events.length - 1]!.changes).toBe(ops);
  });

  test("explain with changes ends planned; a missing hub is hub_not_found; a newline path is a config error", () => {
    const { home, hub, env } = sandbox();
    const ex = decodeStream(raw(["bun", ENGINE, "--dir", hub, "--targets", "claude", "--explain"], env).stdout, "stdout").events;
    expect(ex[ex.length - 1]!.status).toBe("planned");
    const missing = raw(["bun", ENGINE, "--dir", join(home, "nope")], env);
    expect(missing.exitCode).toBe(1);
    expect(decodeStream(missing.stderr, "stderr").events.map((e) => e.code)).toEqual(["hub_not_found"]);
    const nl = raw([WRAPPER, "--print-dir", "--dir", `${home}/a\nb`], env);
    expect(nl.exitCode).toBe(1);
    expect(decodeStream(nl.stderr, "stderr").events.map((e) => e.code)).toEqual(["config"]);
  });

  test("the wrapper treats every option's value as a value, as the engine does", () => {
    const { hub, env } = sandbox();
    for (const opt of ["--skill", "--targets", "--disown-legacy"]) {
      for (const value of ["--print-dir", "--help", "--human"]) {
        const viaWrapper = raw([WRAPPER, "--dir", hub, opt, value], env);
        const viaEngine = raw(["bun", ENGINE, "--dir", hub, opt, value], env);
        expect(viaWrapper.exitCode).toBe(viaEngine.exitCode!);
        const w = decodeOutput(viaWrapper.stdout, viaWrapper.stderr).events;
        expect(w.some((e) => e.kind === "print_dir" || e.kind === "help")).toBe(false);
      }
    }
  });

  test("a write failure other than a closed pipe is an error line on the other stream and exit 1, not a crash", () => {
    const { home, hub, env } = sandbox();
    // stdout opened read-only: every write to it fails with EBADF.
    const p = Bun.spawnSync(["bash", "-c", `exec 1</dev/null; bun "${ENGINE}" --dir "${hub}" --targets claude --dry-run`], {
      env,
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(1);
    const { events } = decodeStream(p.stderr.toString(), "stderr");
    expect(events.some((e) => e.kind === "error" && e.code === "internal")).toBe(true);
  });

  test("with --human, a write failure is reported in prose on the other stream", () => {
    const { home, hub, env } = sandbox();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { alpha: { command: "/bin/user" } } }));
    // stderr opened read-only: the conflict lines cannot be written there.
    const p = Bun.spawnSync(["bash", "-c", `exec 2</dev/null; bun "${ENGINE}" --dir "${hub}" --targets claude --dry-run --human`], {
      env,
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(1);
    const lines = p.stdout.toString().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.startsWith("{")).toBe(false);
    expect(p.stdout.toString()).toContain("cannot write to stderr");
  });

  test("a write that throws synchronously (not a closed pipe) still fails the run and is reported", () => {
    const { hub } = sandbox();
    const savedExit = process.exitCode;
    const orig = { stdout: process.stdout.write, stderr: process.stderr.write };
    const errWrites: string[] = [];
    (process.stdout as unknown as { write: () => boolean }).write = () => {
      const e = new Error("no space left on device") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      errWrites.push(String(s));
      return true;
    };
    let code: number;
    try {
      code = cliMain(["--print-dir", "--dir", hub]);
    } finally {
      process.stdout.write = orig.stdout;
      process.stderr.write = orig.stderr;
      process.exitCode = savedExit ?? 0;
    }
    expect(code).toBe(1);
    const { events } = decodeStream(errWrites.join(""), "stderr");
    expect(events.map((e) => e.code)).toEqual(["internal"]);
  });
});
