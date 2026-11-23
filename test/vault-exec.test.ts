import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { decodeOutput } from "./jsonl.ts";

// Phase 5 (flyingrobots/agent-hub#10): vault-backed, grant-bound `sync-agents exec`.
// The keychain is always a fake `security` (AGENT_HUB_SECURITY_BIN); the real one is never run.

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENGINE = join(REPO_ROOT, "src", "cli.ts");
const WRAPPER = join(REPO_ROOT, "bin", "sync-agents");
const SECRET = "FAKE-vault-value-7f3a9c";
const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

// A fake `security`: `-i` reads add-generic-password commands from stdin into a store
// directory; `find-generic-password ... -a KEY -w` prints the stored value. Every argv is logged.
const FAKE_SECURITY = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_KC/argv.log"
if [[ "$1" == "-i" ]]; then
  while IFS= read -r line; do
    printf '%s\\n' "$line" >> "$FAKE_KC/stdin.log"
    set -- $line
    key=""; hex=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -a) key="$2"; shift ;; -X) hex="$2"; shift ;; esac
      shift
    done
    [[ -n "$key" && -n "$hex" ]] && printf '%s' "$hex" > "$FAKE_KC/item-$key"
  done
  exit 0
fi
if [[ "$1" == "find-generic-password" ]]; then
  key=""
  while [[ $# -gt 0 ]]; do [[ "$1" == "-a" ]] && key="$2"; shift; done
  [[ -f "$FAKE_KC/item-$key" ]] || { echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44; }
  perl -e 'local $/; my $h = <STDIN>; print pack("H*", $h), "\\n"' < "$FAKE_KC/item-$key"
  exit 0
fi
exit 1
`;

function machine() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-vault-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  const kc = join(home, "fake-keychain");
  for (const d of [hub, kc, join(home, ".claude"), join(home, ".cursor")]) mkdirSync(d, { recursive: true });
  const security = join(home, "fake-security");
  writeFileSync(security, FAKE_SECURITY);
  chmodSync(security, 0o755);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    AGENT_HUB_SECURITY_BIN: security,
    AGENT_HUB_EXEC_PATH: WRAPPER,
    FAKE_KC: kc,
  };
  const server = (name: string, doc: unknown) => {
    mkdirSync(join(hub, "mcp", name), { recursive: true });
    writeFileSync(join(hub, "mcp", name, "mcp.json"), `${JSON.stringify(doc, null, 2)}\n`);
  };
  const statePath = (f: string) => join(home, ".local", "state", "agent-hub", f);
  return { home, hub, kc, env, server, statePath };
}

function run(args: string[], env: Record<string, string>, input?: string, cmd: string[] = ["bun", ENGINE]) {
  const p = Bun.spawnSync([...cmd, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : Buffer.from(input) });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  return { exitCode: p.exitCode, stdout, stderr, raw: stdout + stderr, decode: () => decodeOutput(stdout, stderr) };
}

const SH_ARGV = ["/bin/sh", "-c", 'echo "pid=$$"; echo "T=$T"; echo "A=$A"; echo "LEAK=$LEAK"'];

function grantedMachine() {
  const m = machine();
  m.server("s", { mcp: { command: SH_ARGV[0], args: SH_ARGV.slice(1), env: { T: "${vault:k}", A: "1" } } });
  expect(run(["secret", "set", "k"], m.env, `${SECRET}\n`).exitCode).toBe(0);
  const g = run(["secret", "grant", "k", "--to", "s", "--dir", m.hub], m.env);
  expect(g.exitCode).toBe(0);
  return m;
}

describe("vault-backed exec (flyingrobots/agent-hub#10)", () => {
  test("an ungranted exec is refused before any secret is read", () => {
    const m = machine();
    expect(run(["secret", "set", "k"], m.env, `${SECRET}\n`).exitCode).toBe(0);
    const before = readFileSync(join(m.kc, "argv.log"), "utf8");
    const r = run(["exec", "--vault", "T=k", "--", "/usr/bin/printenv", "T"], m.env);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.raw).not.toContain(SECRET);
    const errors = r.decode().events.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    // exec itself never ran the keychain.
    expect(readFileSync(join(m.kc, "argv.log"), "utf8")).toBe(before);
    const audit = readFileSync(m.statePath("exec-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1).outcome).toBe("refused");
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  test("a granted exec replaces the process with the secret in a scrubbed env, and audits it", () => {
    const m = grantedMachine();
    const p = Bun.spawnSync([WRAPPER, "exec", "--keep", "A", "--vault", "T=k", "--", ...SH_ARGV], {
      env: { ...m.env, A: "1", LEAK: "should-not-pass" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    expect(out).toContain(`pid=${p.pid}\n`);
    expect(out).toContain(`T=${SECRET}\n`);
    expect(out).toContain("A=1\n");
    expect(out).toContain("LEAK=\n");
    const audit = readFileSync(m.statePath("exec-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = audit.at(-1);
    expect(last.outcome).toBe("exec");
    expect(last.pid).toBe(p.pid);
    expect(last.argv).toEqual(SH_ARGV);
    expect(last.vault).toEqual([{ env: "T", key: "k" }]);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  test("an exec whose argv differs from the grant is refused", () => {
    const m = grantedMachine();
    const r = run(["exec", "--vault", "T=k", "--", "/bin/sh", "-c", "printenv T"], m.env);
    expect(r.exitCode).toBe(1);
    expect(r.raw).not.toContain(SECRET);
  });

  test("an exec that puts a granted key in a different variable is refused", () => {
    const m = grantedMachine();
    const r = run(["exec", "--vault", "U=k", "--", ...SH_ARGV], m.env);
    expect(r.exitCode).toBe(1);
    expect(r.raw).not.toContain(SECRET);
  });

  test("the exec'd server is the process itself, so SIGKILL leaves no orphan", async () => {
    const m = machine();
    m.server("sl", { mcp: { command: "/bin/sleep", args: ["37"], env: { T: "${vault:k}" } } });
    expect(run(["secret", "set", "k"], m.env, `${SECRET}\n`).exitCode).toBe(0);
    expect(run(["secret", "grant", "k", "--to", "sl", "--dir", m.hub], m.env).exitCode).toBe(0);
    const p = Bun.spawn([WRAPPER, "exec", "--vault", "T=k", "--", "/bin/sleep", "37"], { env: m.env, stdout: "ignore", stderr: "pipe" });
    let comm = "";
    for (let i = 0; i < 100 && !comm.endsWith("sleep"); i++) {
      await Bun.sleep(50);
      comm = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(p.pid)]).stdout.toString().trim();
    }
    expect(comm.endsWith("sleep")).toBe(true);
    expect(Bun.spawnSync(["pgrep", "-P", String(p.pid)]).stdout.toString().trim()).toBe("");
    process.kill(p.pid, "SIGKILL");
    await p.exited;
    expect(Bun.spawnSync(["pgrep", "-f", "sleep 37"]).stdout.toString().trim()).toBe("");
  });

  test("secret set passes the value on stdin, never in argv", () => {
    const m = machine();
    const r = run(["secret", "set", "k"], m.env, `${SECRET}\n`);
    expect(r.exitCode).toBe(0);
    expect(r.raw).not.toContain(SECRET);
    expect(readFileSync(join(m.kc, "argv.log"), "utf8")).not.toContain(SECRET);
    expect(readFileSync(join(m.kc, "stdin.log"), "utf8")).not.toContain(SECRET);
    expect(readFileSync(join(m.kc, "stdin.log"), "utf8")).toContain(Buffer.from(SECRET).toString("hex"));
  });

  test("sync compiles a vault reference to an exec wrapper; no target config holds the secret or the reference", () => {
    const m = grantedMachine();
    const r = run(["--dir", m.hub], m.env);
    expect(r.exitCode).toBe(0);
    const claude = JSON.parse(readFileSync(join(m.home, ".claude.json"), "utf8")).mcpServers.s;
    expect(claude.command).toBe(WRAPPER);
    expect(claude.args).toEqual(["exec", "--keep", "A", "--vault", "T=k", "--", ...SH_ARGV]);
    expect(claude.env).toEqual({ A: "1" });
    for (const f of [join(m.home, ".claude.json"), join(m.home, ".cursor", "mcp.json")]) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("${vault:");
    }
    expect(run(["--dir", m.hub, "--check"], m.env).exitCode).toBe(0);
    // The compiled entry runs as written.
    const p = Bun.spawnSync([claude.command, ...claude.args], { env: { ...m.env, ...claude.env }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain(`T=${SECRET}\n`);
  });

  test("a vault reference outside a stdio env value is refused at sync", () => {
    for (const mcp of [
      { url: "https://h.invalid", headers: { Authorization: "${vault:k}" } },
      { command: "/x", args: ["${vault:k}"] },
      { command: "/x", env: { T: "Bearer ${vault:k}" } },
      { command: "${env:X}", env: { T: "${vault:k}" } },
    ]) {
      const m = machine();
      m.server("s", { mcp });
      const r = run(["--dir", m.hub], m.env);
      expect(r.exitCode).not.toBe(0);
      expect(existsSync(join(m.home, ".claude.json"))).toBe(false);
    }
  });

  test("exec and secret errors are schema'd lines on stderr, never on stdout", () => {
    const m = machine();
    for (const args of [["exec"], ["exec", "--vault", "bad", "--", "/x"], ["exec", "--", "/x"], ["secret"], ["secret", "set"], ["secret", "grant", "k", "--to", "nope", "--dir", m.hub]]) {
      const r = run(args, m.env, "");
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.decode().events.some((e) => e.kind === "error")).toBe(true);
    }
  });

  test("secret revoke removes the grant, and exec is refused again", () => {
    const m = grantedMachine();
    expect(run(["secret", "revoke", "k"], m.env).exitCode).toBe(0);
    expect(run(["exec", "--keep", "A", "--vault", "T=k", "--", ...SH_ARGV], m.env).exitCode).toBe(1);
  });

  test("secret list shows grants and never values", () => {
    const m = grantedMachine();
    const r = run(["secret", "list"], m.env);
    expect(r.exitCode).toBe(0);
    expect(r.raw).not.toContain(SECRET);
    const grants = r.decode().events.filter((e) => e.kind === "grant");
    expect(grants.map((g) => [g.key, g.env, g.argv, g.program, g.keep])).toEqual([["k", "T", SH_ARGV, realpathSync("/bin/sh"), ["A"]]]);
  });

  test("every exec-audit.jsonl line validates against schemas/files/agent_hub.exec_audit.schema.json", () => {
    const m = grantedMachine();
    run(["exec", "--vault", "T=nope", "--", ...SH_ARGV], m.env);
    run(["exec", "--keep", "A", "--vault", "T=k", "--", ...SH_ARGV], m.env);
    const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "files", "agent_hub.exec_audit.schema.json"), "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const lines = readFileSync(m.statePath("exec-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.outcome)).toEqual(["refused", "exec"]);
    for (const l of lines) expect(validate(l)).toBe(true);
  });

});

describe("vault exec repairs (Baker Street PR #48 Moriarty)", () => {
  const keychainCalls = (kc: string) => (existsSync(join(kc, "argv.log")) ? readFileSync(join(kc, "argv.log"), "utf8") : "");

  test("a vault server needs an absolute command; a relative one is refused at sync", () => {
    const m = machine();
    m.server("s", { mcp: { command: "printenv", args: ["T"], env: { T: "${vault:k}" } } });
    expect(run(["--dir", m.hub], m.env).exitCode).not.toBe(0);
    expect(existsSync(join(m.home, ".claude.json"))).toBe(false);
  });

  test("exec refuses a relative command, so PATH cannot pick a different program", () => {
    const m = grantedMachine();
    const evil = join(m.home, "evil");
    mkdirSync(evil);
    writeFileSync(join(evil, "sh"), "#!/bin/sh\necho STOLEN=$T\n");
    chmodSync(join(evil, "sh"), 0o755);
    const r = run(["exec", "--keep", "A", "--vault", "T=k", "--", "sh", ...SH_ARGV.slice(1)], { ...m.env, PATH: `${evil}:${m.env.PATH}` });
    expect(r.exitCode).toBe(1);
    expect(r.raw).not.toContain(SECRET);
    expect(r.raw).not.toContain("STOLEN");
  });

  test("a grant binds the real program: retargeting a symlinked command is refused", () => {
    const m = machine();
    const bin = join(m.home, "bin");
    mkdirSync(bin);
    const good = join(bin, "good");
    const bad = join(bin, "bad");
    writeFileSync(good, "#!/bin/sh\necho good\n");
    writeFileSync(bad, "#!/bin/sh\necho STOLEN=$T\n");
    chmodSync(good, 0o755);
    chmodSync(bad, 0o755);
    const link = join(bin, "server");
    symlinkSync(good, link);
    m.server("s", { mcp: { command: link, env: { T: "${vault:k}" } } });
    expect(run(["secret", "set", "k"], m.env, `${SECRET}\n`).exitCode).toBe(0);
    expect(run(["secret", "grant", "k", "--to", "s", "--dir", m.hub], m.env).exitCode).toBe(0);
    expect(run(["exec", "--vault", "T=k", "--", link], m.env).stdout).toBe("good\n");
    unlinkSync(link);
    symlinkSync(bad, link);
    const r = run(["exec", "--vault", "T=k", "--", link], m.env);
    expect(r.exitCode).toBe(1);
    expect(r.raw).not.toContain("STOLEN");
  });

  test("a --keep set that differs from the grant is refused (no smuggled BASH_ENV or loader variables)", () => {
    const m = grantedMachine();
    for (const keep of [["A", "BASH_ENV"], ["A", "DYLD_INSERT_LIBRARIES"], []]) {
      const r = run(["exec", ...keep.flatMap((k) => ["--keep", k]), "--vault", "T=k", "--", ...SH_ARGV], { ...m.env, A: "1", BASH_ENV: "/x" });
      expect(r.exitCode).toBe(1);
      expect(r.raw).not.toContain(SECRET);
    }
  });

  test("an argv with an extra argument appended or prepended is refused", () => {
    const m = grantedMachine();
    for (const argv of [[...SH_ARGV, "extra"], [SH_ARGV[0]!, "-e", ...SH_ARGV.slice(1)]]) {
      const r = run(["exec", "--keep", "A", "--vault", "T=k", "--", ...argv], m.env);
      expect(r.exitCode).toBe(1);
      expect(r.raw).not.toContain(SECRET);
    }
  });

  test("one granted and one ungranted pair is refused before the keychain is read", () => {
    const m = grantedMachine();
    expect(run(["secret", "set", "other"], m.env, "FAKE-other-value\n").exitCode).toBe(0);
    const before = keychainCalls(m.kc);
    const r = run(["exec", "--keep", "A", "--vault", "T=k", "--vault", "U=other", "--", ...SH_ARGV], m.env);
    expect(r.exitCode).toBe(1);
    expect(keychainCalls(m.kc)).toBe(before);
  });

  test("a vault reference in headers or in extra is refused at sync, and no config gains it", () => {
    for (const doc of [
      { mcp: { url: "https://h.invalid", headers: { "X-Key": "${vault:k}" } } },
      { mcp: { command: "/bin/sh", env: { T: "${vault:k}" } }, overrides: { codex: { extra: { startup_timeout_sec: "${vault:k}" } } } },
      { mcp: { command: "/bin/sh" }, overrides: { codex: { extra: { tool_note: { x: "${vault:k}" } } } } },
    ]) {
      const m = machine();
      mkdirSync(join(m.home, ".codex"), { recursive: true });
      m.server("s", doc);
      expect(run(["--dir", m.hub], m.env).exitCode).not.toBe(0);
      for (const f of [join(m.home, ".claude.json"), join(m.home, ".codex", "config.toml")]) {
        if (existsSync(f)) expect(readFileSync(f, "utf8")).not.toContain("${vault:");
      }
    }
  });

  test("exec does not run when its audit line cannot be written", () => {
    const m = grantedMachine();
    const dir = m.statePath("");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exec-audit.jsonl"), "");
    chmodSync(join(dir, "exec-audit.jsonl"), 0o400);
    const r = run(["exec", "--keep", "A", "--vault", "T=k", "--", ...SH_ARGV], m.env);
    chmodSync(join(dir, "exec-audit.jsonl"), 0o600);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  });

  test("--human after -- belongs to the program: exec's own errors stay JSON lines", () => {
    const m = machine();
    const r = run(["exec", "--vault", "T=k", "--", "/usr/bin/printenv", "--human", "T"], m.env);
    expect(r.exitCode).toBe(1);
    expect(r.decode().events.filter((e) => e.kind === "error").length).toBe(1);
  });

  test("concurrent secret grant runs keep every grant", async () => {
    const m = machine();
    for (let i = 0; i < 6; i++) m.server(`s${i}`, { mcp: { command: "/bin/sh", args: ["-c", `echo ${i}`], env: { T: "${vault:k}" } } });
    const procs = Array.from({ length: 6 }, (_, i) =>
      Bun.spawn(["bun", ENGINE, "secret", "grant", "k", "--to", `s${i}`, "--dir", m.hub], { env: m.env, stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const grants = JSON.parse(readFileSync(m.statePath("grants.json"), "utf8")).grants;
    expect(grants.map((g: { server: string }) => g.server).sort()).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  test("secret list accepts --human", () => {
    const m = grantedMachine();
    const r = run(["secret", "list", "--human"], m.env);
    expect(r.exitCode).toBe(0);
    expect(r.raw).toContain("1 grant(s)");
  });
});


describe("compileVaultSpec refuses a vault reference everywhere but a whole stdio env value", () => {
  test("headers, url, command, args, extra, a partial env value and a relative command are each refused, naming the field", async () => {
    const { compileVaultSpec } = await import("../src/vault.ts");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ url: "https://h.invalid", headers: { "X-Key": "${vault:k}" } }, "headers.X-Key"],
      [{ url: "https://h.invalid/${vault:k}" }, "url"],
      [{ command: "/x${vault:k}" }, "command"],
      [{ command: "/x", args: ["${vault:k}"] }, "args[0]"],
      [{ command: "/x", extra: { a: { b: ["${vault:k}"] } } }, "extra.a.b[0]"],
      [{ command: "/x", env: { T: "Bearer ${vault:k}" } }, "env.T"],
      [{ command: "x", env: { T: "${vault:k}" } }, "absolute command"],
    ];
    for (const [spec, field] of cases) {
      expect(() => compileVaultSpec(spec as never, "/sa")).toThrow(field);
    }
  });
});
