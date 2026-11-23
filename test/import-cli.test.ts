import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { decodeOutput } from "./jsonl.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENGINE = join(REPO_ROOT, "src", "cli.ts");
const WRAPPER = join(REPO_ROOT, "bin", "sync-agents");
const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

// A machine where Claude Code and Cursor are configured by hand, and Codex is installed but empty.
function machine() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-import-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(hub, { recursive: true });
  for (const d of [".claude", ".cursor", ".codex"]) mkdirSync(join(home, d), { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    // Bun's own transpiler cache would otherwise land in $HOME/Library/Caches.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  const writeJson = (p: string, doc: unknown) => {
    writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
    chmodSync(p, 0o600);
  };
  return { home, hub, env, writeJson };
}

function run(args: string[], env: Record<string, string>, cmd: string[] = ["bun", ENGINE]) {
  const p = Bun.spawnSync([...cmd, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const decoded = decodeOutput(p.stdout.toString(), p.stderr.toString());
  return { exitCode: p.exitCode, ...decoded, raw: p.stdout.toString() + p.stderr.toString() };
}

function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      h.update(relative(dir, p));
      if (lstatSync(p).isDirectory()) walk(p);
      else if (!lstatSync(p).isSymbolicLink()) h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

describe("sync-agents import (flyingrobots/agent-hub#7)", () => {
  test("golden: importing Claude and Cursor servers yields a hub whose sync is a no-op and --check exits 0", () => {
    const { home, hub, env, writeJson } = machine();
    writeJson(join(home, ".claude.json"), {
      userId: "keep",
      mcpServers: {
        gh: { type: "stdio", command: "/bin/gh", args: ["mcp"], env: { MODE: "a" } },
        docs: { type: "http", url: "https://docs.invalid/mcp", headers: { "X-Client": "me" } },
      },
    });
    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: { gh: { type: "stdio", command: "/bin/gh", args: ["mcp"], env: { MODE: "a" } } },
    });
    const claudeBefore = readFileSync(join(home, ".claude.json"), "utf8");
    const r = run(["import", "--dir", hub, "--only", "mcp", "--apply", "--adopt"], env);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(hub, "mcp", "gh", "mcp.json"), "utf8"))).toEqual({
      mcp: { command: "/bin/gh", args: ["mcp"], env: { MODE: "a" } },
      overrides: { codex: { disabled: true } },
    });
    expect(JSON.parse(readFileSync(join(hub, "mcp", "docs", "mcp.json"), "utf8")).overrides).toEqual({
      codex: { disabled: true },
      cursor: { disabled: true },
    });
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(claudeBefore);
    const chk = run(["--dir", hub, "--check"], env);
    expect(chk.exitCode).toBe(0);
    const again = run(["--dir", hub], env);
    expect(again.events.filter((e) => e.kind === "op" && e.phase === "sync")).toEqual([]);
  });

  test("--dry-run (the default) writes nothing anywhere", () => {
    const { home, hub, env, writeJson } = machine();
    writeJson(join(home, ".claude.json"), { mcpServers: { gh: { type: "stdio", command: "/bin/gh", args: [] } } });
    mkdirSync(join(home, ".claude", "skills", "mine"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\n");
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# rules\n");
    const before = treeDigest(home);
    for (const args of [["import", "--dir", hub], ["import", "--dir", hub, "--dry-run"]]) {
      const r = run(args, env);
      expect(r.exitCode).toBe(0);
      expect(r.events[r.events.length - 1]!.status).toBe("planned");
      expect(r.events.filter((e) => e.kind === "op").length).toBe(3);
    }
    expect(treeDigest(home)).toBe(before);
  });

  test("a lossy entry is refused with the field that would change, and nothing is written", () => {
    const { home, hub, env, writeJson } = machine();
    writeJson(join(home, ".claude.json"), {
      mcpServers: {
        ok: { type: "stdio", command: "/bin/ok", args: [] },
        bad: { type: "stdio", command: "/bin/x", args: [], env: { A: "${VAR:-fallback}" } },
      },
    });
    const r = run(["import", "--dir", hub, "--only", "mcp", "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('"bad"');
    expect(existsSync(join(hub, "mcp"))).toBe(false);
  });

  test("a plaintext secret is refused unless --rewrite-secrets, which prints only variable names", () => {
    const { home, hub, env, writeJson } = machine();
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    writeJson(join(home, ".claude.json"), {
      mcpServers: { gh: { type: "stdio", command: "/bin/gh", args: [], env: { GITHUB_TOKEN: token } } },
    });
    const refused = run(["import", "--dir", hub, "--only", "mcp", "--apply"], env);
    expect(refused.exitCode).toBe(1);
    expect(existsSync(join(hub, "mcp"))).toBe(false);
    expect(refused.raw).not.toContain(token);
    const ok = run(["import", "--dir", hub, "--only", "mcp", "--apply", "--rewrite-secrets"], env);
    expect(ok.exitCode).toBe(0);
    expect(ok.raw).not.toContain(token);
    expect(ok.raw).toContain("GITHUB_TOKEN");
    expect(readFileSync(join(hub, "mcp", "gh", "mcp.json"), "utf8")).not.toContain(token);
    expect(JSON.parse(readFileSync(join(hub, "mcp", "gh", "mcp.json"), "utf8")).mcp.env.GITHUB_TOKEN).toBe("${env:GITHUB_TOKEN}");
  });

  test("aggregation is deterministic: two identical machines give identical hub bytes", () => {
    const digests: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { home, hub, env, writeJson } = machine();
      writeJson(join(home, ".claude.json"), { mcpServers: { b: { type: "http", url: "https://b.invalid" }, a: { type: "stdio", command: "/a", args: [] } } });
      writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { a: { type: "stdio", command: "/a", env: { X: "1" } }, b: { url: "https://b.invalid" } } });
      expect(run(["import", "--dir", hub, "--only", "mcp", "--apply"], env).exitCode).toBe(0);
      digests.push(treeDigest(join(hub, "mcp")));
    }
    expect(digests[0]).toBe(digests[1]);
  });

  test("rules and skills: an identical rules file and a skill of the agent's own are imported, then adopted", () => {
    const { home, hub, env } = machine();
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# My rules\n");
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# My rules\n");
    mkdirSync(join(home, ".claude", "skills", "mine"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: d\n---\n");
    const r = run(["import", "--dir", hub, "--apply", "--adopt"], env);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(hub, "AGENTS.md"), "utf8")).toBe("# My rules\n");
    expect(existsSync(join(hub, "skills", "mine", "SKILL.md"))).toBe(true);
    expect(run(["--dir", hub, "--check"], env).exitCode).toBe(0);
  });

  test("differing rules files are refused, and nothing is written", () => {
    const { home, hub, env } = machine();
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# one\n");
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# two\n");
    const r = run(["import", "--dir", hub, "--only", "rules", "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(hub, "AGENTS.md"))).toBe(false);
  });

  test("import and pull go through the wrapper too, with their own help", () => {
    const { hub, env } = machine();
    for (const sub of ["import", "pull"]) {
      const h = run([sub, "--help"], env, [WRAPPER]);
      expect(h.exitCode).toBe(0);
      expect(h.events[0]!.kind).toBe("help");
      expect(String(h.events[0]!.command)).toBe(`sync-agents ${sub}`);
    }
    expect(run(["import", "--dir", hub, "--bogus"], env, [WRAPPER]).exitCode).toBe(2);
  });
});

describe("sync-agents pull (flyingrobots/agent-hub#7)", () => {
  test("after pulling an entry added with the agent's own tool, sync-agents --check exits 0", () => {
    const { home, hub, env, writeJson } = machine();
    // As `claude mcp add` would leave it.
    writeJson(join(home, ".claude.json"), { mcpServers: { newsrv: { type: "stdio", command: "/bin/new", args: ["--x"], env: {} } } });
    const plan = run(["pull", "--from", "claude", "mcp/newsrv", "--dir", hub], env);
    expect(plan.exitCode).toBe(0);
    expect(existsSync(join(hub, "mcp", "newsrv"))).toBe(false);
    const r = run(["pull", "--from", "claude", "mcp/newsrv", "--dir", hub, "--apply"], env);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(hub, "mcp", "newsrv", "mcp.json"), "utf8")).mcp).toEqual({ command: "/bin/new", args: ["--x"] });
    expect(run(["--dir", hub, "--check"], env).exitCode).toBe(0);
    // Cursor and Codex received it from the sync that followed.
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.newsrv).toBeDefined();
  });

  test("--as-override records a differing agent's entry as overrides.<agent>", () => {
    const { home, hub, env, writeJson } = machine();
    mkdirSync(join(hub, "mcp", "s"), { recursive: true });
    writeFileSync(join(hub, "mcp", "s", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/s", env: { MODE: "a" } } }));
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { s: { type: "stdio", command: "/bin/s", env: { MODE: "cursor" } } } });
    expect(run(["pull", "--from", "cursor", "mcp/s", "--dir", hub, "--apply"], env).exitCode).toBe(1);
    const r = run(["pull", "--from", "cursor", "mcp/s", "--dir", hub, "--apply", "--as-override"], env);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(hub, "mcp", "s", "mcp.json"), "utf8")).overrides).toEqual({ cursor: { env: { MODE: "cursor" } } });
    expect(run(["--dir", hub, "--check"], env).exitCode).toBe(0);
  });

  test("pull refuses a lossy entry with its field diff and writes nothing", () => {
    const { home, hub, env, writeJson } = machine();
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { s: { type: "stdio", command: "/bin/s", env: { A: "${userHome}/x" } } } });
    const r = run(["pull", "--from", "cursor", "mcp/s", "--dir", hub, "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(hub, "mcp", "s"))).toBe(false);
  });
});

describe("import and pull repairs (Baker Street PR #34 Moriarty)", () => {
  test("a secret in extra is refused even with --rewrite-secrets, and never printed", () => {
    const { home, hub, env, writeJson } = machine();
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const token = "sk-FAKE3333abcdefghijklmnopqrstuvwxyz";
    writeJson(join(home, ".config", "opencode", "opencode.json"), { mcp: { servers: { oc: { type: "remote", url: "https://o.invalid", oauth: { clientSecret: token } } } } });
    const r = run(["import", "--dir", hub, "--from", "opencode", "--only", "mcp", "--rewrite-secrets", "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(r.raw).not.toContain(token);
    expect(existsSync(join(hub, "mcp", "oc"))).toBe(false);
  });

  test("a token pasted into bearer_token_env_var is refused without being printed", () => {
    const { home, hub, env } = machine();
    const token = "sk-ant-FAKE1111abcdefghijklmnop";
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.s]\nurl = "https://h.invalid"\nbearer_token_env_var = "${token}"\n`);
    const r = run(["import", "--dir", hub, "--only", "mcp", "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(r.raw).not.toContain(token);
  });

  test("Codex extra that config.toml cannot hold (nested tables) is refused at import", () => {
    const { home, hub, env } = machine();
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.nest]\ncommand = "/x"\n\n[mcp_servers.nest.tools.foo]\napprove = true\n`);
    const r = run(["import", "--dir", hub, "--only", "mcp", "--from", "codex", "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(hub, "mcp", "nest"))).toBe(false);
  });

  test("a broken config in another agent does not block --from", () => {
    const { home, hub, env, writeJson } = machine();
    writeFileSync(join(home, ".claude.json"), "{ not json");
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { s: { type: "stdio", command: "/s" } } });
    expect(run(["import", "--dir", hub, "--only", "mcp", "--from", "cursor", "--apply"], env).exitCode).toBe(0);
    expect(existsSync(join(hub, "mcp", "s", "mcp.json"))).toBe(true);
  });

  test("server names that are not valid hub names are refused; nothing is written outside the hub", () => {
    const { home, hub, env, writeJson } = machine();
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { "../../escaped": { type: "stdio", command: "/x" }, "a/b": { type: "stdio", command: "/y" } } });
    const r = run(["import", "--dir", hub, "--only", "mcp", "--from", "cursor", "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, "escaped"))).toBe(false);
    expect(existsSync(join(hub, "mcp"))).toBe(false);
  });

  test("pull --as-override sees a difference only in extra", () => {
    const { home, hub, env, writeJson } = machine();
    mkdirSync(join(hub, "mcp", "s"), { recursive: true });
    writeFileSync(join(hub, "mcp", "s", "mcp.json"), JSON.stringify({ mcp: { command: "/x", env: { A: "1" } } }));
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { s: { type: "stdio", command: "/x", env: { A: "1" }, envFile: "/e" } } });
    const r = run(["pull", "--from", "cursor", "mcp/s", "--dir", hub, "--as-override", "--apply"], env);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(hub, "mcp", "s", "mcp.json"), "utf8")).overrides.cursor.extra).toEqual({ envFile: "/e" });
    expect(run(["--dir", hub, "--check"], env).exitCode).toBe(0);
  });

  test("a skill unsafe to install is refused before anything is written; differing symlink targets differ", () => {
    const { home, hub, env } = machine();
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# r\n");
    for (const [a, target] of [[".claude", "/etc/hosts"], [".codex", "/etc/passwd"]] as const) {
      mkdirSync(join(home, a, "skills", "s"), { recursive: true });
      writeFileSync(join(home, a, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
      require("node:fs").symlinkSync(target, join(home, a, "skills", "s", "l"));
    }
    const r = run(["import", "--dir", hub, "--apply"], env);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(hub, "AGENTS.md"))).toBe(false);
    const one = machine();
    writeFileSync(join(one.home, ".claude", "CLAUDE.md"), "# r\n");
    mkdirSync(join(one.home, ".claude", "skills", "s"), { recursive: true });
    writeFileSync(join(one.home, ".claude", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    require("node:fs").symlinkSync("/etc/hosts", join(one.home, ".claude", "skills", "s", "l"));
    const r1 = run(["import", "--dir", one.hub, "--apply"], one.env);
    expect(r1.exitCode).toBe(1);
    expect(existsSync(join(one.hub, "AGENTS.md"))).toBe(false);
  });

  test("--apply with --dry-run or -n is refused in either order", () => {
    const { hub, env } = machine();
    for (const args of [["--dry-run", "--apply"], ["--apply", "--dry-run"], ["--apply", "-n"], ["-n", "--apply"]]) {
      expect(run(["import", "--dir", hub, ...args], env).exitCode).toBe(2);
    }
  });
});
