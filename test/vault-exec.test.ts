import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    expect(grants.map((g) => [g.key, g.env, g.argv])).toEqual([["k", "T", SH_ARGV]]);
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
