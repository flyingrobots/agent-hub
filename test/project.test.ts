import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeOutput, type DecodedEvent } from "./jsonl.ts";
// Imported lazily so the CLI tests report their own failures before src/project.ts exists.
const validator = async () => (await import("../src/project.ts" as string)).validateLockEntryPath as (p: string, kind: "file" | "link") => string | null;

// Phase 6 (flyingrobots/agent-hub#11): project mode with an attacker-safe .agents/sync.lock.json.
// Every run uses a sandbox HOME/XDG and a fake `security`; the real home and keychain are never touched.

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENGINE = join(REPO_ROOT, "src", "cli.ts");
const LOCK = join(".agents", "sync.lock.json");
const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

type Sandbox = ReturnType<typeof sandbox>;

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-project-")));
  tempRoots.push(root);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  for (const d of [home, repo, outside, join(home, ".claude"), join(home, ".cursor")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".claude.json"), "{}\n");
  const security = join(root, "fake-security");
  writeFileSync(security, "#!/bin/sh\necho fake-security-must-not-run >&2\nexit 1\n");
  chmodSync(security, 0o755);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    AGENT_HUB_SECURITY_BIN: security,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  return { root, home, repo, outside, env };
}

/** A project hub: AGENTS.md, one skill, one stdio server. */
function seedHub(repo: string, servers: Record<string, unknown> = { fs: { mcp: { command: "npx", args: ["-y", "fs-server"] } } }) {
  const hub = join(repo, ".agents");
  mkdirSync(join(hub, "skills", "demo"), { recursive: true });
  writeFileSync(join(hub, "AGENTS.md"), "# Project rules\n");
  writeFileSync(join(hub, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
  for (const [name, doc] of Object.entries(servers)) {
    mkdirSync(join(hub, "mcp", name), { recursive: true });
    writeFileSync(join(hub, "mcp", name, "mcp.json"), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return hub;
}

function run(sb: Sandbox, args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  // A timeout kills a hung run, so a regression fails instead of hanging the suite.
  const p = Bun.spawnSync(["bun", ENGINE, ...args], { env: sb.env, cwd: opts.cwd ?? sb.root, stdout: "pipe", stderr: "pipe", ...(opts.timeout ? { timeout: opts.timeout } : {}) });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  const decoded = decodeOutput(stdout, stderr);
  return { exitCode: p.exitCode, raw: stdout + stderr, ...decoded };
}

function project(sb: Sandbox, repo: string, ...extra: string[]) {
  return run(sb, ["--project", "--dir", repo, ...extra], { timeout: 30_000 });
}

function git(sb: Sandbox, cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { env: sb.env, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** Every regular file and symlink under dir, with its bytes or link target. */
function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`L ${p} ${readlinkSync(p)}\n`);
      else if (st.isDirectory()) {
        h.update(`D ${p}\n`);
        walk(p);
      } else h.update(`F ${p} ${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
    }
  };
  walk(dir);
  return h.digest("hex");
}

const errorCodes = (events: DecodedEvent[]) => events.filter((e) => e._schema.id === "agent_hub.error").map((e) => e.code);
const conflicts = (events: DecodedEvent[]) => events.filter((e) => e._schema.id === "agent_hub.conflict");
const sha = (p: string) => `sha256:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;

const OUTPUT_FILES = [".mcp.json", ".cursor/mcp.json", "opencode.json", ".codex/config.toml"];

describe("project mode golden path (flyingrobots/agent-hub#11)", () => {
  test("project sync writes the known outputs and a sorted, machine-independent lockfile", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    const before = project(sb, sb.repo, "--check");
    expect(before.exitCode).toBe(1);
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(0);
    const claude = JSON.parse(readFileSync(join(sb.repo, ".mcp.json"), "utf8"));
    expect(claude.mcpServers.fs.command).toBe("npx");
    expect(readFileSync(join(sb.repo, ".mcp.json"), "utf8").endsWith("}\n")).toBe(true);
    expect(JSON.parse(readFileSync(join(sb.repo, ".cursor", "mcp.json"), "utf8")).mcpServers.fs.command).toBe("npx");
    const oc = JSON.parse(readFileSync(join(sb.repo, "opencode.json"), "utf8"));
    expect(oc.$schema).toBe("https://opencode.ai/config.json");
    expect(oc.mcp.fs).toBeDefined();
    expect(readFileSync(join(sb.repo, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.fs]");
    expect(readlinkSync(join(sb.repo, "CLAUDE.md"))).toBe(".agents/AGENTS.md");
    expect(readlinkSync(join(sb.repo, "AGENTS.md"))).toBe(".agents/AGENTS.md");
    expect(readlinkSync(join(sb.repo, ".claude", "skills", "demo"))).toBe("../../.agents/skills/demo");
    expect(readFileSync(join(sb.repo, ".claude", "skills", "demo", "SKILL.md"), "utf8")).toContain("name: demo");

    const lockText = readFileSync(join(sb.repo, LOCK), "utf8");
    const lock = JSON.parse(lockText);
    expect(Object.keys(lock)).toEqual(["version", "files", "links"]);
    expect(lock.version).toBe(1);
    expect(Object.keys(lock.files)).toEqual([...OUTPUT_FILES].sort());
    for (const f of OUTPUT_FILES) expect(lock.files[f]).toBe(sha(join(sb.repo, f)));
    expect(lock.links).toEqual({
      ".claude/skills/demo": "../../.agents/skills/demo",
      "AGENTS.md": ".agents/AGENTS.md",
      "CLAUDE.md": ".agents/AGENTS.md",
    });
    expect(lockText).not.toContain(sb.root);
    expect(lockText).not.toContain(sb.home);
    expect(lockText.endsWith("}\n")).toBe(true);

    const check = project(sb, sb.repo, "--check");
    expect(check.exitCode).toBe(0);
    const again = project(sb, sb.repo);
    expect(again.exitCode).toBe(0);
    expect(readFileSync(join(sb.repo, LOCK), "utf8")).toBe(lockText);
  });

  test("a git clone of a synced repo passes --project --check with a byte-identical lockfile", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    git(sb, sb.repo, "init", "-q");
    git(sb, sb.repo, "add", "-A");
    git(sb, sb.repo, "commit", "-q", "-m", "init");
    const clone = join(sb.root, "elsewhere", "clone");
    mkdirSync(join(sb.root, "elsewhere"));
    git(sb, join(sb.root, "elsewhere"), "clone", "-q", sb.repo, clone);
    const check = project(sb, clone, "--check");
    expect(check.stderr).toBe("");
    expect(check.exitCode).toBe(0);
    expect(readFileSync(join(clone, LOCK), "utf8")).toBe(readFileSync(join(sb.repo, LOCK), "utf8"));
    // Without --dir, the repo is the git toplevel of the working directory.
    const nested = join(clone, ".agents", "skills");
    const fromCwd = run(sb, ["--project", "--check"], { cwd: nested });
    expect(fromCwd.exitCode).toBe(0);
  });

  test("a repo moved to another path still passes --project --check", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    const moved = join(sb.root, "moved", "repo");
    mkdirSync(join(sb.root, "moved"));
    const cp = Bun.spawnSync(["cp", "-a", sb.repo, moved]);
    expect(cp.exitCode).toBe(0);
    rmSync(sb.repo, { recursive: true, force: true });
    expect(project(sb, moved, "--check").exitCode).toBe(0);
  });

  test("outside a git repository without --dir, project mode fails with a config error", () => {
    const sb = sandbox();
    const res = run(sb, ["--project"], { cwd: sb.outside });
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
  });
});

describe("hostile lockfile entries are rejected, nothing written (flyingrobots/agent-hub#11)", () => {
  const hostile: Array<{ name: string; label: string; kind: "files" | "links"; rel: string }> = [
    {
      name: "hostile lock entry rejected: parent escape",
      label: "parent escape",
      kind: "files",
      rel: "../outside/x",
    },
    {
      name: "hostile lock entry rejected: absolute path",
      label: "absolute path",
      kind: "files",
      rel: "/etc/passwd",
    },
    {
      name: "hostile lock entry rejected: dot-dot segment",
      label: "dot-dot segment",
      kind: "files",
      rel: "a/../b",
    },
    {
      name: "hostile lock entry rejected: git hook",
      label: "git hook",
      kind: "files",
      rel: ".git/hooks/pre-commit",
    },
    {
      name: "hostile lock entry rejected: package.json",
      label: "package.json",
      kind: "files",
      rel: "package.json",
    },
    {
      name: "hostile lock entry rejected: hub file",
      label: "hub file",
      kind: "files",
      rel: ".agents/AGENTS.md",
    },
    {
      name: "hostile lock entry rejected: NUL byte",
      label: "NUL byte",
      kind: "files",
      rel: ".mcp.json\u0000x",
    },
    {
      name: "hostile lock entry rejected: backslash",
      label: "backslash",
      kind: "files",
      rel: ".cursor\\mcp.json",
    },
    {
      name: "hostile lock entry rejected: file listed as a link",
      label: "file listed as a link",
      kind: "links",
      rel: ".mcp.json",
    },
    {
      name: "hostile lock entry rejected: link with a foreign target",
      label: "link with a foreign target",
      kind: "links",
      rel: "CLAUDE.md",
    },
  ];
  for (const c of hostile) {
    const { label, kind, rel } = c;
    test(c.name, () => {
      const sb = sandbox();
      seedHub(sb.repo);
      writeFileSync(join(sb.outside, "x"), "victim\n");
      const victimDigest = treeDigest(sb.outside);
      const value = kind === "files" ? `sha256:${"0".repeat(64)}` : label.includes("foreign") ? "/etc/passwd" : ".agents/AGENTS.md";
      const lockText = `${JSON.stringify({ version: 1, files: kind === "files" ? { [rel]: value } : {}, links: kind === "links" ? { [rel]: value } : {} }, null, 2)}\n`;
      writeFileSync(join(sb.repo, LOCK), lockText);
      const res = project(sb, sb.repo);
      expect(res.exitCode).toBe(1);
      expect(errorCodes(res.events)).toEqual(["config"]);
      for (const f of [...OUTPUT_FILES, "CLAUDE.md", "AGENTS.md", ".claude"]) expect(existsSync(join(sb.repo, f))).toBe(false);
      expect(readFileSync(join(sb.repo, LOCK), "utf8")).toBe(lockText);
      expect(treeDigest(sb.outside)).toBe(victimDigest);
      expect(project(sb, sb.repo, "--check").exitCode).toBe(1);
    });
  }

  test("a lock entry under a symlink that escapes the repo is rejected", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    mkdirSync(join(sb.outside, "skills", "x"), { recursive: true });
    writeFileSync(join(sb.outside, "skills", "x", "keep"), "victim\n");
    symlinkSync(sb.outside, join(sb.repo, ".claude"));
    const victimDigest = treeDigest(sb.outside);
    writeFileSync(join(sb.repo, LOCK), `${JSON.stringify({ version: 1, files: {}, links: { ".claude/skills/x": "../../.agents/skills/x" } })}\n`);
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    expect(treeDigest(sb.outside)).toBe(victimDigest);
    expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
  });

  test("project mode never writes through a symlinked output directory", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    symlinkSync(sb.outside, join(sb.repo, ".cursor"));
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(existsSync(join(sb.outside, "mcp.json"))).toBe(false);
    expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
  });

  test("a malformed or duplicate-key lockfile fails closed", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    for (const text of ["<<<<<<< HEAD\n{}\n", '{"version": 2, "files": {}, "links": {}}\n', '{"version": 1, "files": {}, "links": {}, "extra": 1}\n', '{"version": 1, "files": {".mcp.json": "sha256:00"}, "links": {}}\n', '{"version": 1, "files": {}, "files": {"package.json": "x"}, "links": {}}\n']) {
      writeFileSync(join(sb.repo, LOCK), text);
      const res = project(sb, sb.repo);
      expect(res.exitCode).toBe(1);
      expect(errorCodes(res.events)).toEqual(["config"]);
      expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
    }
  });

  test("pruning requires an exact digest match: an edited file is kept and reported as a conflict", () => {
    const sb = sandbox();
    seedHub(sb.repo, { fs: { mcp: { command: "npx" } }, gone: { mcp: { command: "uvx" } } });
    expect(project(sb, sb.repo).exitCode).toBe(0);
    // Drop every server: all four MCP files stop being intended.
    rmSync(join(sb.repo, ".agents", "mcp"), { recursive: true, force: true });
    writeFileSync(join(sb.repo, ".mcp.json"), '{"mcpServers": {}, "mine": true}\n');
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(conflicts(res.events).length).toBe(1);
    expect(readFileSync(join(sb.repo, ".mcp.json"), "utf8")).toContain('"mine"');
    expect(existsSync(join(sb.repo, ".cursor", "mcp.json"))).toBe(true);
    // Restore the user's bytes to nothing of theirs: the unedited outputs are pruned.
    rmSync(join(sb.repo, ".mcp.json"));
    const pruned = project(sb, sb.repo);
    expect(pruned.exitCode).toBe(0);
    for (const f of OUTPUT_FILES) expect(existsSync(join(sb.repo, f))).toBe(false);
    expect(JSON.parse(readFileSync(join(sb.repo, LOCK), "utf8")).files).toEqual({});
  });
});

// Deterministic PRNG (mulberry32), so the fuzz corpus is the same on every run.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("lockfile path validator fuzz (flyingrobots/agent-hub#11)", () => {
  test("the validator accepts exactly the known output set over 200 seeded paths", async () => {
    const validateLockEntryPath = await validator();
    // Independent oracle: written from the spec, not from src/project.ts.
    const oracleFiles = new Set([".mcp.json", ".cursor/mcp.json", "opencode.json", ".codex/config.toml"]);
    const oracle = (p: string, kind: "file" | "link"): boolean => {
      if (kind === "file") return oracleFiles.has(p);
      if (p === "CLAUDE.md" || p === "AGENTS.md") return true;
      const m = /^\.claude\/skills\/([^/]+)$/.exec(p);
      return m !== null && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m[1]!);
    };
    const atoms = ["..", ".", "", "/", "//", "\u0000", "\\", "é", "‮", ".mcp.json", ".cursor", "mcp.json", "opencode.json", ".codex", "config.toml", "CLAUDE.md", "AGENTS.md", ".claude", "skills", "demo", "x.y", "-a", ".git", "hooks", "package.json", ".agents", " "];
    const rnd = mulberry32(0x5eed11);
    const corpus = new Set<string>([".mcp.json", ".cursor/mcp.json", "opencode.json", ".codex/config.toml", "CLAUDE.md", "AGENTS.md", ".claude/skills/demo", ".claude/skills/..", ".claude/skills/.hidden", "./.mcp.json", ".cursor//mcp.json", "/.mcp.json", ".mcp.json/", ".claude/skills/a/b", ".claude/skills/"]);
    while (corpus.size < 215) {
      const n = 1 + Math.floor(rnd() * 4);
      const parts: string[] = [];
      for (let i = 0; i < n; i += 1) parts.push(atoms[Math.floor(rnd() * atoms.length)]!);
      corpus.add(parts.join(rnd() < 0.8 ? "/" : ""));
    }
    let accepted = 0;
    for (const p of corpus) {
      for (const kind of ["file", "link"] as const) {
        const got = validateLockEntryPath(p, kind) === null;
        if (got !== oracle(p, kind)) throw new Error(`validator disagrees with oracle for ${JSON.stringify(p)} (${kind}): validator ${got ? "accepts" : "rejects"}`);
        if (got) accepted += 1;
      }
    }
    expect(corpus.size).toBeGreaterThanOrEqual(200);
    expect(accepted).toBeGreaterThan(5);
  });
});

describe("ownership of project outputs (flyingrobots/agent-hub#11)", () => {
  test("an unmanaged existing .mcp.json is a conflict; --adopt adopts identical bytes only", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    // The intended bytes, from a sync of an identical hub elsewhere.
    const ref = join(sb.root, "ref");
    mkdirSync(ref);
    seedHub(ref);
    expect(project(sb, ref).exitCode).toBe(0);
    const intended = readFileSync(join(ref, ".mcp.json"));
    writeFileSync(join(sb.repo, ".mcp.json"), '{"mcpServers": {"mine": {"command": "x"}}}\n');
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(conflicts(res.events).length).toBe(1);
    expect(existsSync(join(sb.repo, ".cursor", "mcp.json"))).toBe(false);
    expect(project(sb, sb.repo, "--adopt").exitCode).toBe(1);
    writeFileSync(join(sb.repo, ".mcp.json"), intended);
    expect(project(sb, sb.repo).exitCode).toBe(1);
    const adopted = project(sb, sb.repo, "--adopt");
    expect(adopted.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(sb.repo, LOCK), "utf8")).files[".mcp.json"]).toBe(sha(join(sb.repo, ".mcp.json")));
    expect(project(sb, sb.repo, "--check").exitCode).toBe(0);
  });

  test("a user-edited owned file is a conflict; --force rewrites it", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    const good = readFileSync(join(sb.repo, ".mcp.json"), "utf8");
    writeFileSync(join(sb.repo, ".mcp.json"), '{"edited": true}\n');
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(conflicts(res.events).length).toBe(1);
    expect(readFileSync(join(sb.repo, ".mcp.json"), "utf8")).toBe('{"edited": true}\n');
    expect(project(sb, sb.repo, "--check").exitCode).toBe(1);
    expect(project(sb, sb.repo, "--force").exitCode).toBe(0);
    expect(readFileSync(join(sb.repo, ".mcp.json"), "utf8")).toBe(good);
  });

  test("an owned, unedited output is rewritten when the hub changes", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    writeFileSync(join(sb.repo, ".agents", "mcp", "fs", "mcp.json"), `${JSON.stringify({ mcp: { command: "uvx", args: ["fs"] } })}\n`);
    expect(project(sb, sb.repo, "--check").exitCode).toBe(1);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(sb.repo, ".mcp.json"), "utf8")).mcpServers.fs.command).toBe("uvx");
    expect(project(sb, sb.repo, "--check").exitCode).toBe(0);
  });

  test("--relock rebuilds the lockfile from outputs that equal the intended bytes, never claiming others", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    const lockText = readFileSync(join(sb.repo, LOCK), "utf8");
    writeFileSync(join(sb.repo, LOCK), `<<<<<<< ours\n${lockText}=======\n{}\n>>>>>>> theirs\n`);
    expect(project(sb, sb.repo).exitCode).toBe(1);
    const relock = project(sb, sb.repo, "--relock");
    expect(relock.exitCode).toBe(0);
    expect(readFileSync(join(sb.repo, LOCK), "utf8")).toBe(lockText);
    writeFileSync(join(sb.repo, ".cursor", "mcp.json"), '{"edited": true}\n');
    expect(project(sb, sb.repo, "--relock").exitCode).toBe(0);
    const lock = JSON.parse(readFileSync(join(sb.repo, LOCK), "utf8"));
    expect(lock.files[".cursor/mcp.json"]).toBeUndefined();
    expect(lock.files[".mcp.json"]).toBe(sha(join(sb.repo, ".mcp.json")));
  });
});

describe("project mode secrets and scope (flyingrobots/agent-hub#11)", () => {
  test("a vault server compiles to the bare sync-agents launcher and no grant is created", () => {
    const sb = sandbox();
    seedHub(sb.repo, { s: { mcp: { command: "/bin/echo", args: ["hi"], env: { T: "${vault:k}" } } } });
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("secret grant k --to s");
    const entry = JSON.parse(readFileSync(join(sb.repo, ".mcp.json"), "utf8")).mcpServers.s;
    expect(entry.command).toBe("sync-agents");
    expect(entry.args).toEqual(["exec", "--vault", "T=k", "--", "/bin/echo", "hi"]);
    expect(readFileSync(join(sb.repo, ".codex", "config.toml"), "utf8")).toContain('command = "sync-agents"');
    expect(existsSync(join(sb.home, ".local", "state", "agent-hub", "grants.json"))).toBe(false);
    for (const f of OUTPUT_FILES) expect(readFileSync(join(sb.repo, f), "utf8")).not.toContain(sb.home);
    // The explicit grant works against the project hub and binds the inner argv.
    const grant = run(sb, ["secret", "grant", "k", "--to", "s", "--dir", join(sb.repo, ".agents")]);
    expect(grant.exitCode).toBe(0);
    const grants = JSON.parse(readFileSync(join(sb.home, ".local", "state", "agent-hub", "grants.json"), "utf8"));
    expect(JSON.stringify(grants)).toContain('["/bin/echo","hi"]');
    expect(project(sb, sb.repo, "--check").exitCode).toBe(0);
  });

  test("a plaintext secret literal blocks project mode", () => {
    const sb = sandbox();
    seedHub(sb.repo, { gh: { mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345" } } } });
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(res.events.some((e) => e._schema.id === "agent_hub.warning" && e.code === "plaintext_secret")).toBe(true);
    expect(errorCodes(res.events)).toEqual(["config"]);
    for (const f of OUTPUT_FILES) expect(existsSync(join(sb.repo, f))).toBe(false);
    expect(existsSync(join(sb.repo, LOCK))).toBe(false);
    expect(res.raw).not.toContain("ghp_0123456789abcdefghijABCDEFGHIJ012345");
  });

  test("Antigravity is never written in project mode", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo, "--targets", "antigravity").exitCode).toBe(0);
    expect(existsSync(join(sb.repo, LOCK))).toBe(false);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    expect(existsSync(join(sb.repo, ".gemini"))).toBe(false);
    expect(existsSync(join(sb.home, ".gemini"))).toBe(false);
    expect(readdirSync(sb.repo).sort()).toEqual([".agents", ".claude", ".codex", ".cursor", ".mcp.json", "AGENTS.md", "CLAUDE.md", "opencode.json"]);
  });

  test("--targets limits project outputs and never prunes excluded agents", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    const lockText = readFileSync(join(sb.repo, LOCK), "utf8");
    rmSync(join(sb.repo, ".agents", "mcp"), { recursive: true, force: true });
    expect(project(sb, sb.repo, "--targets", "claude:mcp").exitCode).toBe(0);
    expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
    expect(existsSync(join(sb.repo, ".cursor", "mcp.json"))).toBe(true);
    const lock = JSON.parse(readFileSync(join(sb.repo, LOCK), "utf8"));
    expect(lock.files[".mcp.json"]).toBeUndefined();
    expect(lock.files[".cursor/mcp.json"]).toBe(JSON.parse(lockText).files[".cursor/mcp.json"]);
  });

  test("project mode leaves the user's home byte-identical", () => {
    const sb = sandbox();
    seedHub(sb.repo, { fs: { mcp: { command: "npx", env: { TOKEN: "${env:TOKEN}" } } } });
    const before = treeDigest(sb.home);
    expect(project(sb, sb.repo, "--check").exitCode).toBe(1);
    expect(project(sb, sb.repo, "--explain").exitCode).toBe(0);
    expect(project(sb, sb.repo, "--dry-run").exitCode).toBe(0);
    // Read-only modes leave the home byte-identical, state directory included.
    expect(treeDigest(sb.home)).toBe(before);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    expect(project(sb, sb.repo, "--check").exitCode).toBe(0);
    // An apply run's only trace is its writer lock (never a config, ledger or grant): remove
    // exactly that file and its directories, and the home is byte-identical again.
    const locks = join(sb.home, ".local", "state", "agent-hub", "project-locks");
    const lockFiles = readdirSync(locks);
    expect(lockFiles.length).toBe(1);
    expect(lockFiles[0]).toMatch(/^[0-9a-f]{64}\.lock$/);
    rmSync(join(sb.home, ".local"), { recursive: true, force: true });
    expect(treeDigest(sb.home)).toBe(before);
  });

  test("--dry-run and --explain plan project outputs without writing", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    const dry = project(sb, sb.repo, "--dry-run");
    expect(dry.exitCode).toBe(0);
    expect(dry.events.some((e) => e._schema.id === "agent_hub.op" && e.phase === "plan")).toBe(true);
    const explain = project(sb, sb.repo, "--explain");
    expect(explain.exitCode).toBe(0);
    expect(explain.events.some((e) => e._schema.id === "agent_hub.op" && e.phase === "explain")).toBe(true);
    expect(readdirSync(sb.repo)).toEqual([".agents"]);
    const human = Bun.spawnSync(["bun", ENGINE, "--project", "--dir", sb.repo, "--dry-run", "--human"], { env: sb.env, stdout: "pipe", stderr: "pipe" });
    expect(human.stdout.toString()).not.toContain('"_schema"');
  });
});

test("the lock entry validator accepts known names only for their kind (flyingrobots/agent-hub#11)", async () => {
  const validateLockEntryPath = await validator();
  expect(validateLockEntryPath(".mcp.json", "file")).toBeNull();
  expect(validateLockEntryPath(".mcp.json", "link")).not.toBeNull();
  expect(validateLockEntryPath(".claude/skills/demo", "link")).toBeNull();
});

describe("Baker Street repairs (flyingrobots/agent-hub#11, PR flyingrobots/agent-hub#52)", () => {
  const leakServer = (secret: string) => `${JSON.stringify({ mcp: { command: "/bin/echo", env: { API_KEY: secret } }, allowPlaintextFields: ["env.API_KEY"] })}\n`;
  const noLeak = (sb: Sandbox, needle: string, res: { raw: string }) => {
    expect(res.raw).not.toContain(needle);
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) expect(readFileSync(p, "utf8")).not.toContain(needle);
      }
    };
    walk(sb.repo);
  };

  test("a symlinked mcp.json pointing outside the repo is refused and its secret is never written", () => {
    const sb = sandbox();
    seedHub(sb.repo, {});
    const secret = "sk-live-VICTIMSECRET0123456789abcdef";
    writeFileSync(join(sb.outside, "mcp.json"), leakServer(secret));
    mkdirSync(join(sb.repo, ".agents", "mcp", "stolen"), { recursive: true });
    symlinkSync(join(sb.outside, "mcp.json"), join(sb.repo, ".agents", "mcp", "stolen", "mcp.json"));
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    expect(res.stderr).toContain(".agents/mcp/stolen/mcp.json");
    for (const f of OUTPUT_FILES) expect(existsSync(join(sb.repo, f))).toBe(false);
    noLeak(sb, secret, res);
  });

  test("a symlinked .agents/mcp directory is refused", () => {
    const sb = sandbox();
    seedHub(sb.repo, {});
    rmSync(join(sb.repo, ".agents", "mcp"), { recursive: true, force: true });
    mkdirSync(join(sb.outside, "mcp", "leak"), { recursive: true });
    writeFileSync(join(sb.outside, "mcp", "leak", "mcp.json"), `${JSON.stringify({ mcp: { command: "/bin/echo", args: ["OUTSIDE_ARG"] } })}\n`);
    symlinkSync(join(sb.outside, "mcp"), join(sb.repo, ".agents", "mcp"));
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    noLeak(sb, "OUTSIDE_ARG", res);
  });

  test("a symlinked per-agent override file is refused", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    writeFileSync(join(sb.outside, "ov.json"), `${JSON.stringify({ mcp: { args: ["OUTSIDE_OVERRIDE"] } })}\n`);
    mkdirSync(join(sb.repo, ".agents", "mcp", "fs", "cursor"));
    symlinkSync(join(sb.outside, "ov.json"), join(sb.repo, ".agents", "mcp", "fs", "cursor", "mcp.json"));
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    noLeak(sb, "OUTSIDE_OVERRIDE", res);
  });

  test("a FIFO at a hub mcp.json fails closed instead of hanging", () => {
    const sb = sandbox();
    seedHub(sb.repo, {});
    mkdirSync(join(sb.repo, ".agents", "mcp", "f"), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(sb.repo, ".agents", "mcp", "f", "mcp.json")]).exitCode).toBe(0);
    for (const extra of [[], ["--check"]]) {
      const res = project(sb, sb.repo, ...extra);
      expect(res.exitCode).toBe(1);
      expect(errorCodes(res.events)).toEqual(["config"]);
    }
  }, 90_000);

  test("a FIFO lockfile fails closed in a normal run and is replaced by --relock without hanging", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(Bun.spawnSync(["mkfifo", join(sb.repo, LOCK)]).exitCode).toBe(0);
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    const relock = project(sb, sb.repo, "--relock");
    expect(relock.exitCode).toBe(0);
    expect(lstatSync(join(sb.repo, LOCK)).isFile()).toBe(true);
  }, 90_000);

  test("a symlinked lockfile is refused by a normal run and replaced with a regular file by --relock", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    const lockText = readFileSync(join(sb.repo, LOCK), "utf8");
    writeFileSync(join(sb.outside, "lock.json"), lockText);
    rmSync(join(sb.repo, LOCK));
    symlinkSync(join(sb.outside, "lock.json"), join(sb.repo, LOCK));
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    const relock = project(sb, sb.repo, "--relock");
    expect(relock.exitCode).toBe(0);
    expect(lstatSync(join(sb.repo, LOCK)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(sb.repo, LOCK), "utf8")).toBe(lockText);
    expect(readFileSync(join(sb.outside, "lock.json"), "utf8")).toBe(lockText);
    expect(project(sb, sb.repo, "--check").exitCode).toBe(0);
  });

  test("a git toplevel that is not an ancestor of the working directory is refused", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    git(sb, sb.repo, "init", "-q");
    const victim = join(sb.outside, "victimdir");
    seedHub(victim);
    const victimDigest = treeDigest(sb.outside);
    git(sb, sb.repo, "config", "core.worktree", victim);
    const res = run(sb, ["--project"], { cwd: sb.repo, timeout: 30_000 });
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    expect(treeDigest(sb.outside)).toBe(victimDigest);
    expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
  });

  test("prototype names are never lockfile keys", async () => {
    const validateLockEntryPath = await validator();
    for (const k of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(validateLockEntryPath(k, "file")).not.toBeNull();
      expect(validateLockEntryPath(k, "link")).not.toBeNull();
    }
    const sb = sandbox();
    seedHub(sb.repo);
    for (const k of ["toString", "constructor", "__proto__"]) {
      writeFileSync(join(sb.repo, LOCK), `{"version": 1, "files": {${JSON.stringify(k)}: "sha256:${"0".repeat(64)}"}, "links": {}}\n`);
      const res = project(sb, sb.repo);
      expect(res.exitCode).toBe(1);
      expect(errorCodes(res.events)).toEqual(["config"]);
      expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
    }
  });

  test("a duplicate key that would otherwise parse cleanly fails closed and is named", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    writeFileSync(join(sb.repo, LOCK), '{"version": 1, "files": {}, "links": {}, "links": {}}\n');
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    expect(res.stderr).toContain('duplicate key "links"');
    expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
  });

  test("a lock entry under a symlinked ancestor inside the repo fails closed before any output is written", () => {
    const sb = sandbox();
    // Cursor gets no server, so the locked .cursor/mcp.json would be a prune.
    seedHub(sb.repo, { fs: { mcp: { command: "npx" }, overrides: { cursor: { disabled: true } } } });
    mkdirSync(join(sb.repo, "realcursor"));
    writeFileSync(join(sb.repo, "realcursor", "mcp.json"), '{"mcpServers": {}}\n');
    symlinkSync("realcursor", join(sb.repo, ".cursor"));
    writeFileSync(join(sb.repo, LOCK), `${JSON.stringify({ version: 1, files: { ".cursor/mcp.json": sha(join(sb.repo, "realcursor", "mcp.json")) }, links: {} })}\n`);
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    expect(res.events.some((e) => e._schema.id === "agent_hub.op")).toBe(false);
    for (const f of [".mcp.json", "opencode.json", ".codex", "CLAUDE.md", "AGENTS.md", ".claude"]) expect(existsSync(join(sb.repo, f))).toBe(false);
    expect(existsSync(join(sb.repo, "realcursor", "mcp.json"))).toBe(true);
  });

  test("a destination that changes between planning and apply is not overwritten", async () => {
    const sb = sandbox();
    seedHub(sb.repo);
    const { runSync } = await import("./jsonl.ts");
    const res = runSync(
      { project: true, hubDir: sb.repo, cwd: sb.root, homeDir: sb.home, xdgStateHome: join(sb.home, ".local", "state") },
      { afterPlanBeforeApply: () => writeFileSync(join(sb.repo, ".mcp.json"), '{"raced": true}\n') },
    );
    expect(res.exitCode).toBe(1);
    expect(res.events.filter((e) => e.id === "agent_hub.error").map((e) => e.data.code)).toEqual(["apply"]);
    expect(readFileSync(join(sb.repo, ".mcp.json"), "utf8")).toBe('{"raced": true}\n');
    expect(existsSync(join(sb.repo, LOCK))).toBe(false);
  });

  const caseInsensitive = (() => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-case-")));
    writeFileSync(join(d, "a"), "");
    const ci = existsSync(join(d, "A"));
    rmSync(d, { recursive: true, force: true });
    return ci;
  })();

  test.skipIf(!caseInsensitive)("a case-only skill rename on a case-insensitive volume fails before writing anything", () => {
    const sb = sandbox();
    seedHub(sb.repo);
    expect(project(sb, sb.repo).exitCode).toBe(0);
    const lockText = readFileSync(join(sb.repo, LOCK), "utf8");
    rmSync(join(sb.repo, ".claude", "skills", "demo"));
    Bun.spawnSync(["mv", join(sb.repo, ".agents", "skills", "demo"), join(sb.repo, ".agents", "skills", "Demo")]);
    const res = project(sb, sb.repo);
    expect(res.exitCode).toBe(1);
    expect(errorCodes(res.events)).toEqual(["config"]);
    expect(readdirSync(join(sb.repo, ".claude", "skills"))).toEqual([]);
    expect(readFileSync(join(sb.repo, LOCK), "utf8")).toBe(lockText);
  });

  test("a second project run on the same repo waits for the writer lock and writes nothing", async () => {
    const sb = sandbox();
    seedHub(sb.repo);
    const { acquireApplyLock, releaseApplyLock } = await import("../src/lock.ts");
    const { projectLockPath } = (await import("../src/project.ts" as string)) as { projectLockPath: (repo: string, home: string, xdgStateHome?: string) => string };
    const held = acquireApplyLock(projectLockPath(sb.repo, sb.home, join(sb.home, ".local", "state")), sb.repo);
    try {
      const res = project(sb, sb.repo);
      expect(res.exitCode).toBe(1);
      expect(errorCodes(res.events)).toEqual(["lock"]);
      expect(existsSync(join(sb.repo, ".mcp.json"))).toBe(false);
      // Read-only modes never take the lock.
      expect(project(sb, sb.repo, "--dry-run").exitCode).toBe(0);
    } finally {
      releaseApplyLock(held);
    }
    expect(project(sb, sb.repo).exitCode).toBe(0);
  });
});
