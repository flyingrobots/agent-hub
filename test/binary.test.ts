/**
 * Integration suite for the standalone `bun build --compile` binary (flyingrobots/agent-hub#8).
 *
 * Everything here runs the compiled executable, never `bun src/cli.ts`, against sandbox
 * HOMEs. The binary comes from `bun run build:bin` (dist/sync-agents), or from
 * $AGENT_HUB_BINARY when a caller (the release workflow) wants to test an artifact it
 * already built.
 *
 * The suite skips only when `bun build --compile` itself cannot produce a trivial
 * executable on this machine. Under CI (`$CI` set) that is a failure instead, so the
 * binary job can never pass vacuously.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_USAGE } from "../src/cli.ts";

// Each install.sh --binary run copies and executes an ~88 MB binary (macOS validates its signature
// on first exec); these took 3.5-5 s locally, so the 5 s default flaked.
setDefaultTimeout(30_000);
import { getStatePaths, loadOwnershipState, loadPendingJournal } from "../src/state.ts";
import { decodeOutput, isSyncAgents, type DecodedEvent } from "./jsonl.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");
const DIST_BIN = join(REPO_ROOT, "dist", "sync-agents");
const IS_CI = Boolean(process.env.CI);

const suiteRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-bin-suite-")));

function spawnText(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string | undefined>),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/**
 * Bun 1.4.5 leaves an ~87 MB `.<hash>-00000000.bun-build` copy of itself in the working
 * directory after a host-target `bun build --compile`. Every compile this suite runs
 * directly uses suiteRoot as its cwd; build:bin must clean up after itself.
 */
function bunBuildLeftovers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".bun-build"));
}

// 1. Is `bun build --compile` usable here at all? Probe with a trivial program.
function probeCompile(): string | null {
  const dir = join(suiteRoot, "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe.ts"), 'console.log("compile-ok");\n');
  const out = join(dir, "probe-bin");
  const build = spawnText(["bun", "build", join(dir, "probe.ts"), "--compile", "--outfile", out], {
    cwd: suiteRoot,
  });
  if (build.exitCode !== 0) return `bun build --compile failed: ${build.stderr.trim() || build.stdout.trim()}`;
  const run = spawnText([out]);
  if (run.exitCode !== 0 || run.stdout.trim() !== "compile-ok") {
    return `compiled probe did not run (exit ${run.exitCode}): ${run.stderr.trim()}`;
  }
  return null;
}

const compileUnavailable = probeCompile();
if (compileUnavailable && IS_CI) {
  throw new Error(`binary suite cannot be skipped under CI: ${compileUnavailable}`);
}
if (compileUnavailable) {
  console.warn(`[binary.test] SKIPPING compiled-binary suite: ${compileUnavailable}`);
}

// 2. Produce the binary under test exactly the way users do: `bun run build:bin`.
const externalBinary = process.env.AGENT_HUB_BINARY ? resolve(process.env.AGENT_HUB_BINARY) : null;
let buildResult: { exitCode: number | null; stdout: string; stderr: string } | null = null;
const leftoversBefore = new Set([
  ...bunBuildLeftovers(REPO_ROOT),
  ...bunBuildLeftovers(join(REPO_ROOT, "dist")).map((n) => `dist/${n}`),
]);
if (!compileUnavailable && !externalBinary) {
  buildResult = spawnText(["bun", "run", "build:bin"], { cwd: REPO_ROOT });
}
const leakedByBuild = [
  ...bunBuildLeftovers(REPO_ROOT),
  ...bunBuildLeftovers(join(REPO_ROOT, "dist")).map((n) => `dist/${n}`),
].filter((n) => !leftoversBefore.has(n));
const BIN = externalBinary ?? DIST_BIN;

const tempRoots: string[] = [];

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-bin-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "skills"), { recursive: true });
  mkdirSync(join(hub, "mcp"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "skills"), { recursive: true });

  writeFileSync(join(hub, "AGENTS.md"), "# Binary Test Rules\n");
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ userId: "keep-me", theme: "dark" }, null, 2) + "\n",
  );
  chmodSync(join(home, ".claude.json"), 0o600);
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  chmodSync(join(home, ".codex", "config.toml"), 0o600);

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  return { home, hub, env };
}

function run(cmd: string[], env: Record<string, string | undefined>, cwd?: string) {
  // Deliberately minimal PATH-only environment plus the sandbox HOME/XDG variables.
  return spawnText(cmd, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });
}

function sb(env: Record<string, string>) {
  return (args: string[], cwd?: string) => {
    const r = run([BIN, ...args], env, cwd);
    if (args.includes("--human")) return { ...r, events: [] as DecodedEvent[] };
    return { ...r, ...decodeOutput(r.stdout, r.stderr) };
  };
}

function writeSkill(hub: string, name: string) {
  const dir = join(hub, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
  return dir;
}

function writeMcp(hub: string, name: string, command: string) {
  mkdirSync(join(hub, "mcp", name), { recursive: true });
  writeFileSync(join(hub, "mcp", name, "mcp.json"), JSON.stringify({ mcp: { command } }));
}

/** First bytes of a native executable: Mach-O 64-bit (either byte order) or ELF. */
function isNativeExecutable(path: string): boolean {
  const head = readFileSync(path).subarray(0, 4);
  const hex = Buffer.from(head).toString("hex");
  return hex === "cffaedfe" || hex === "feedfacf" || hex === "7f454c46";
}

/** Set an extended attribute with the platform's native tooling; returns false if unsupported. */
function setXattr(path: string, name: string, value: string): boolean {
  if (process.platform === "darwin") {
    return Bun.spawnSync(["/usr/bin/xattr", "-w", name, value, path]).exitCode === 0;
  }
  const py = Bun.spawnSync([
    "python3",
    "-c",
    "import os,sys; os.setxattr(sys.argv[1], 'user.' + sys.argv[2], sys.argv[3].encode())",
    path,
    name,
    value,
  ]);
  return py.exitCode === 0;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

describe.skipIf(compileUnavailable !== null)("compiled sync-agents binary", () => {
  test("bun run build:bin produces a native dist/sync-agents executable", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts?.["build:bin"]).toContain("--compile");
    expect(pkg.scripts?.["build:bin"]).toContain("--outfile sync-agents");
    if (!externalBinary) {
      expect(buildResult?.stderr ?? "").not.toContain("error");
      expect(buildResult?.exitCode).toBe(0);
    }
    expect(existsSync(BIN)).toBe(true);
    expect(isNativeExecutable(BIN)).toBe(true);
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split("\n")).toContain("dist/");
  });

  test("the binary ignores a .env, a bunfig.toml preload and a tsconfig paths hijack in its working directory (flyingrobots/agent-hub#26)", () => {
    const { home, env } = makeSandbox();
    const cwd = join(home, "checkout");
    const marker = join(home, "PRELOAD-RAN");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, ".env"), `AGENTS_DIR=${home}/decoy\n`);
    writeFileSync(join(cwd, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    writeFileSync(join(cwd, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
    writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "*": ["./preload.ts"] } } }));
    const r = run([BIN, "--print-dir"], env, cwd);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(join(home, ".agents"));
    expect(existsSync(marker)).toBe(false);
  });

  test("bun run build:bin leaves no .bun-build temp files in the repo or dist/", () => {
    if (externalBinary) return; // nothing was built here
    expect(leakedByBuild).toEqual([]);
  });

  test("--help prints the CLI usage and exits 0; usage errors exit 2", () => {
    const { env } = makeSandbox();
    const help = sb(env)(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.events[0]!._schema.id).toBe("agent_hub.help");
    expect(help.events[0]!.usage).toBe(CLI_USAGE);
    expect(help.events.slice(1).every((e) => e.kind === "schema")).toBe(true);
    expect(sb(env)(["--help", "--human"]).stdout.trim()).toBe(CLI_USAGE);

    const bogus = sb(env)(["--bogus-flag"]);
    expect(bogus.exitCode).toBe(2);
    expect(bogus.stderr).toContain("unknown option: --bogus-flag");

    const badTarget = sb(env)(["--targets", "notatarget"]);
    expect(badTarget.exitCode).toBe(2);
    expect(badTarget.stderr).toContain('unknown target "notatarget"');

    const missingDir = sb(env)(["--print-dir", "--dir"]);
    expect(missingDir.exitCode).toBe(2);
  });

  test("--print-dir resolves --dir > $AGENTS_DIR > config.json > ~/.agents", () => {
    const { home, env } = makeSandbox();
    expect(sb(env)(["--print-dir"]).stdout.trim()).toBe(join(home, ".agents"));

    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agent-hub", "config.json"),
      JSON.stringify({ agentsDir: "~/cfg-hub" }),
    );
    expect(sb(env)(["--print-dir"]).stdout.trim()).toBe(join(home, "cfg-hub"));

    const withEnv = sb({ ...env, AGENTS_DIR: join(home, "env-hub") });
    expect(withEnv(["--print-dir"]).stdout.trim()).toBe(join(home, "env-hub"));
    const r = withEnv(["--dir", join(home, "cli-hub"), "--print-dir"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(join(home, "cli-hub"));
  });

  test("golden: full sync of links, skills and MCP, then --check exits 0 and re-sync is zero-churn", () => {
    const { home, hub, env } = makeSandbox();
    const skillDir = writeSkill(hub, "bin-skill");
    writeMcp(hub, "bin-mcp", "/usr/bin/bin-mcp");
    const cli = sb(env);

    const r = cli([]);
    expect(r.exitCode).toBe(0);
    expect(readlinkSync(join(home, ".claude", "CLAUDE.md"))).toBe(join(hub, "AGENTS.md"));
    expect(readlinkSync(join(home, ".codex", "AGENTS.md"))).toBe(join(hub, "AGENTS.md"));
    expect(readlinkSync(join(home, ".claude", "skills", "bin-skill"))).toBe(skillDir);
    const claudeCfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claudeCfg.userId).toBe("keep-me");
    expect(claudeCfg.mcpServers["bin-mcp"].command).toBe("/usr/bin/bin-mcp");
    expect(
      Bun.TOML.parse(readFileSync(join(home, ".codex", "config.toml"), "utf8")),
    ).toMatchObject({ model: "gpt-5", mcp_servers: { "bin-mcp": { command: "/usr/bin/bin-mcp" } } });

    const chk = cli(["--check"]);
    expect(chk.exitCode).toBe(0);
    expect(chk.stdout).toContain("everything is in sync");

    const again = cli([]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).not.toContain("[sync]");

    // Pruning through the binary removes what it owns.
    rmSync(skillDir, { recursive: true, force: true });
    rmSync(join(hub, "mcp", "bin-mcp"), { recursive: true, force: true });
    expect(cli([]).exitCode).toBe(0);
    expect(() => lstatSync(join(home, ".claude", "skills", "bin-skill"))).toThrow();
    expect(
      JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers?.["bin-mcp"],
    ).toBeUndefined();
    expect(cli(["--check"]).exitCode).toBe(0);
  });

  test("scoped --targets run touches only the selected target", () => {
    const { home, hub, env } = makeSandbox();
    const cli = sb(env);

    const r = cli(["--targets", "claude"]);
    expect(r.exitCode).toBe(0);
    expect(readlinkSync(join(home, ".claude", "CLAUDE.md"))).toBe(join(hub, "AGENTS.md"));
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);

    expect(cli(["--check", "--targets", "claude"]).exitCode).toBe(0);
    // The unscoped check still sees the codex link it was never asked to create.
    expect(cli(["--check"]).exitCode).toBe(1);
  });

  test("an unmanaged MCP collision is a conflict: exit 1 with the personal entry preserved", () => {
    const { home, hub, env } = makeSandbox();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { foo: { type: "stdio", command: "/personal/foo", args: [] } } }, null, 2) +
        "\n",
    );
    writeMcp(hub, "foo", "/canonical/foo");
    const cli = sb(env);

    const chk = cli(["--check"]);
    expect(chk.exitCode).toBe(1);
    expect(chk.stderr).toContain("[conflict]");

    const r = cli([]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.foo.command).toBe(
      "/personal/foo",
    );
  });

  test("native xattr FFI inside the binary: differing extended attributes block --adopt, identical ones adopt", () => {
    const { home, hub, env } = makeSandbox();
    const canon = writeSkill(hub, "xattr-skill");
    const dst = join(home, ".claude", "skills", "xattr-skill");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, "SKILL.md"), readFileSync(join(canon, "SKILL.md")));
    for (const p of [join(canon, "SKILL.md"), join(dst, "SKILL.md")]) chmodSync(p, 0o644);
    chmodSync(canon, 0o755);
    chmodSync(dst, 0o755);

    const okA = setXattr(join(canon, "SKILL.md"), "agenthub.test", "A");
    const okB = setXattr(join(dst, "SKILL.md"), "agenthub.test", "B");
    if (!okA || !okB) {
      if (IS_CI) throw new Error("could not set a test xattr under CI; the FFI path would go untested");
      console.warn("[binary.test] filesystem rejected test xattrs; skipping the xattr assertions");
      return;
    }

    const cli = sb(env);
    const refused = cli(["--adopt"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("extended attributes differ");
    expect(lstatSync(dst).isDirectory()).toBe(true);

    expect(setXattr(join(dst, "SKILL.md"), "agenthub.test", "A")).toBe(true);
    const adopted = cli(["--adopt"]);
    expect(adopted.exitCode).toBe(0);
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dst)).toBe(canon);
  });

  test("flock(2) inside compiled binaries: SIGKILL mid-apply is refused while held, then recovered by the next binary run", async () => {
    // Compile the hookable harness: same bundled lock/metadata FFI, but it can pause mid-apply.
    const harnessDir = join(suiteRoot, "harness");
    mkdirSync(harnessDir, { recursive: true });
    const harness = join(harnessDir, "sigkill-child");
    if (!existsSync(harness)) {
      const built = spawnText([
        "bun",
        "build",
        join(REPO_ROOT, "test", "fixtures", "sigkill-child.ts"),
        "--compile",
        "--outfile",
        harness,
      ], { cwd: suiteRoot });
      expect(built.exitCode).toBe(0);
    }
    expect(isNativeExecutable(harness)).toBe(true);

    const { home, hub, env } = makeSandbox();
    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    const marker = join(home, "sigkill-ready.flag");
    const targetLink = join(home, ".claude", "CLAUDE.md");

    const child = Bun.spawn(
      [harness, hub, home, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, targetLink, marker],
      { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
    );
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await Bun.sleep(15);
      }
      expect(existsSync(marker)).toBe(true);

      // The real binary must see the harness's kernel lock and refuse cleanly.
      const concurrent = sb(env)([]);
      expect(concurrent.exitCode).toBe(1);
      expect(concurrent.stderr).toContain("another sync-agents apply process holds");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(child.signalCode).toBe("SIGKILL");

    // Mid-apply state on disk: link written, journal pending, ledger not yet updated.
    expect(readlinkSync(targetLink)).toBe(join(hub, "AGENTS.md"));
    expect(loadPendingJournal(paths.journalPath)).not.toBeNull();
    expect(loadOwnershipState(paths.statePath, hub).state.links[targetLink]).toBeUndefined();

    const cli = sb(env);
    expect(cli(["--check"]).exitCode).toBe(1);

    const recovered = cli([]);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout).toContain("[recover]");
    expect(loadPendingJournal(paths.journalPath)).toBeNull();
    expect(loadOwnershipState(paths.statePath, hub).state.links[targetLink]?.target).toBe(
      join(hub, "AGENTS.md"),
    );
    expect(cli(["--check"]).exitCode).toBe(0);
  }, 60_000);
});

describe.skipIf(compileUnavailable !== null)("install.sh --binary", () => {
  // A PATH of symlinks to /usr/bin and /bin minus bun and python, with an mv that logs each call.
  function minimalHostPath(root: string): { path: string; mvLog: string } {
    const tools = join(root, "tools");
    mkdirSync(tools, { recursive: true });
    for (const d of ["/usr/bin", "/bin"]) {
      for (const n of readdirSync(d)) {
        if (/^(python|pip|bun|mv$)/.test(n) || existsSync(join(tools, n))) continue;
        try {
          symlinkSync(join(d, n), join(tools, n));
        } catch {
          // skip unreadable entries
        }
      }
    }
    const mvLog = join(root, "mv.log");
    writeFileSync(join(tools, "mv"), `#!/bin/sh\necho "$@" >> "${mvLog}"\nexec /bin/mv "$@"\n`);
    chmodSync(join(tools, "mv"), 0o755);
    return { path: tools, mvLog };
  }

  test("without Bun or python3, the binary's own hub view still blocks a prefix that is the configured hub", () => {
    const { home, env } = makeSandbox();
    const { path } = minimalHostPath(home);
    const rt = join(home, "rt");
    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(join(home, ".config", "agent-hub", "config.json"), JSON.stringify({ agentsDir: rt }));
    const r = run([INSTALL_SH, "--binary", BIN, "--prefix", rt, "--bin-dir", join(home, ".local", "bin"), "--no-skill"], { ...env, PATH: path });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/overlaps hub directory|neither bun nor python3/);
    expect(existsSync(rt)).toBe(false);
  });

  // python3 accepts NaN in JSON; the engine (JSON.parse) does not, so the wrapper and the binary
  // see different hubs. Skipped only where no working python3 exists.
  const python3Works = Bun.spawnSync(["python3", "-c", "import json; json.loads('NaN')"]).exitCode === 0;
  test.skipIf(!python3Works)("the binary's own --print-dir blocks a prefix the wrapper's view misses (Baker Street PR #17 CK-F-1)", () => {
    const { home, env } = makeSandbox();
    const { path } = minimalHostPath(home);
    const py = Bun.spawnSync(["sh", "-c", "command -v python3"], { stdout: "pipe" }).stdout.toString().trim();
    symlinkSync(py, join(path, "python3"));
    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(join(home, ".config", "agent-hub", "config.json"), `{"agentsDir": "${join(home, "elsewhere")}", "x": NaN}\n`);
    const binaryHub = join(home, ".agents");
    const r = run([INSTALL_SH, "--binary", BIN, "--prefix", binaryHub, "--bin-dir", join(home, ".local", "bin"), "--no-skill"], { ...env, PATH: path });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("the binary's --print-dir");
  });

  test("without Bun on PATH, upgrading a binary runtime is one atomic exchange (no two-step rename)", () => {
    const { home, env } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");
    const base = [INSTALL_SH, "--binary", BIN, "--prefix", prefix, "--bin-dir", binDir, "--no-skill"];
    const { path, mvLog } = minimalHostPath(home);
    expect(run(base, { ...env, PATH: path }).exitCode).toBe(0);
    writeFileSync(mvLog, "");
    const upgrade = run(base, { ...env, PATH: path });
    expect(upgrade.exitCode).toBe(0);
    const moves = readFileSync(mvLog, "utf8");
    expect(moves).not.toContain(prefix);
    expect(Bun.spawnSync([join(binDir, "sync-agents"), "--help"]).exitCode).toBe(0);
  });

  test("installs the compiled binary as the runtime, keeps marker and shim semantics, and passes --check", () => {
    const { home, hub, env } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");

    const res = run([INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir, "--binary", BIN], env);
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);

    const runtimeBin = join(prefix, "bin", "sync-agents");
    expect(readlinkSync(join(binDir, "sync-agents"))).toBe(runtimeBin);
    expect(lstatSync(runtimeBin).isFile()).toBe(true);
    expect(isNativeExecutable(runtimeBin)).toBe(true);
    expect(readFileSync(runtimeBin).equals(readFileSync(BIN))).toBe(true);
    expect(existsSync(join(prefix, "src"))).toBe(false);
    expect(existsSync(join(prefix, "skills", "agent-hub", "SKILL.md"))).toBe(true);
    const marker = JSON.parse(readFileSync(join(prefix, ".agent-hub-runtime"), "utf8"));
    expect(marker).toMatchObject({ product: "agent-hub", kind: "runtime", layout: "binary" });

    // The installed bundled skill reached the hub through the binary itself.
    expect(existsSync(join(hub, "skills", "agent-hub", "SKILL.md"))).toBe(true);
    const chk = run([join(binDir, "sync-agents"), "--check"], env);
    expect(chk.exitCode).toBe(0);
  });

  test("swaps between source and binary layouts in place under the existing marker guard", () => {
    const { home, env } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");
    const base = [INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir, "--no-skill"];

    expect(run(base, env).exitCode).toBe(0);
    expect(existsSync(join(prefix, "src", "cli.ts"))).toBe(true);

    expect(run([...base, `--binary=${BIN}`], env).exitCode).toBe(0);
    expect(existsSync(join(prefix, "src"))).toBe(false);
    expect(isNativeExecutable(join(prefix, "bin", "sync-agents"))).toBe(true);

    expect(run(base, env).exitCode).toBe(0);
    expect(existsSync(join(prefix, "src", "cli.ts"))).toBe(true);
    expect(isNativeExecutable(join(prefix, "bin", "sync-agents"))).toBe(false);

    // No staging or quarantine directories leak next to the prefix.
    const leftovers = Bun.spawnSync(["ls", "-A", home]).stdout.toString().split("\n");
    expect(leftovers.filter((n) => n.startsWith(".agent-hub-stage") || n.startsWith(".agent-hub-old"))).toEqual([]);
  });

  test("refuses a missing argument, a non-executable, a script, or a non-agent-hub program, leaving the prefix untouched", () => {
    const { home, env } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");
    const base = [INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir, "--no-skill"];

    const missing = run([...base, "--binary"], env);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("--binary requires an argument");
    expect(missing.stderr).not.toContain("unbound variable");

    const absent = run([...base, "--binary", join(home, "nope")], env);
    expect(absent.exitCode).toBe(1);
    expect(absent.stderr).toContain("not an executable regular file");

    // The source wrapper is a script, not a compiled binary.
    const script = run([...base, "--binary", join(REPO_ROOT, "bin", "sync-agents")], env);
    expect(script.exitCode).toBe(1);
    expect(script.stderr).toContain("not a native executable");

    // The compile probe is a real native executable, but not agent-hub.
    const impostor = run([...base, "--binary", join(suiteRoot, "probe", "probe-bin")], env);
    expect(impostor.exitCode).toBe(1);
    expect(impostor.stderr).toContain("not a compiled sync-agents binary");

    // A shebang-less script that prints the usage line is still not a native executable.
    const fake = join(home, "fake-sync-agents");
    writeFileSync(fake, 'echo "Usage: sync-agents [OPTIONS]"\n');
    chmodSync(fake, 0o755);
    const shebangless = run([...base, "--binary", fake], env);
    expect(shebangless.exitCode).toBe(1);
    expect(shebangless.stderr).toContain("not a native executable");

    if (process.platform === "darwin") {
      // A quarantined download must be refused before it is executed (Gatekeeper would block).
      const q = join(home, "quarantined-sync-agents");
      copyFileSync(BIN, q);
      chmodSync(q, 0o755);
      expect(
        Bun.spawnSync(["xattr", "-w", "com.apple.quarantine", "0081;00000000;Safari;", q]).exitCode,
      ).toBe(0);
      const quarantined = run([...base, "--binary", q], env);
      expect(quarantined.exitCode).toBe(1);
      expect(quarantined.stderr).toContain("xattr -d com.apple.quarantine");
    }

    expect(existsSync(prefix)).toBe(false);
    expect(existsSync(join(binDir, "sync-agents"))).toBe(false);
  });
});
