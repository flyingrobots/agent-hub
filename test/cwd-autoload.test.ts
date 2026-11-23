/**
 * Bun loads `.env`, `bunfig.toml` and `tsconfig.json`/`jsconfig.json` (the last two also from
 * parent directories) by default. Nothing a directory holds may change where sync-agents reads or
 * writes, or run code (flyingrobots/agent-hub#26).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WRAPPER = join(REPO_ROOT, "bin", "sync-agents");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

/** A sandbox HOME with a hub, plus a hostile working directory: .env redirects, bunfig preloads. */
export function hostileSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-cwd-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "skills"), { recursive: true });
  writeFileSync(join(hub, "AGENTS.md"), "# rules\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const decoy = join(home, "decoy");
  const marker = join(home, "PRELOAD-RAN");
  // Run from a subdirectory: Bun also finds tsconfig.json in parent directories.
  const repo = join(home, "checkout");
  const cwd = join(repo, "sub");
  mkdirSync(cwd, { recursive: true });
  // A tsconfig "paths" mapping that would replace any module, the entry point included.
  writeFileSync(join(repo, "hijack.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "hijacked");\n`);
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "*": ["./hijack.ts"] } } }));
  writeFileSync(join(repo, "jsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "*": ["./hijack.ts"] } } }));
  writeFileSync(join(cwd, ".env"), `AGENTS_DIR=${decoy}/hub\nXDG_STATE_HOME=${decoy}/state\nXDG_CONFIG_HOME=${decoy}/config\n`);
  // Bun also loads .env.local and .env.<NODE_ENV>.
  writeFileSync(join(cwd, ".env.local"), `AGENTS_DIR=${decoy}/hub-local\n`);
  writeFileSync(join(cwd, ".env.production"), `XDG_STATE_HOME=${decoy}/state-production\n`);
  writeFileSync(join(cwd, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  writeFileSync(join(cwd, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, NODE_ENV: "production" };
  return { home, hub, decoy, marker, cwd, env };
}

function run(cmd: string[], env: Record<string, string>, cwd: string) {
  const p = Bun.spawnSync(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("the working directory's .env, bunfig.toml and tsconfig/jsconfig are ignored (flyingrobots/agent-hub#26)", () => {
  test("wrapper --print-dir, through its bun config reader, is neither redirected nor preloaded", () => {
    const { home, hub, decoy, marker, cwd, env } = hostileSandbox();
    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(join(home, ".config", "agent-hub", "config.json"), JSON.stringify({ agentsDir: hub }));
    const r = run([WRAPPER, "--print-dir"], env, cwd);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(hub);
    expect(r.stdout).not.toContain(decoy);
    expect(existsSync(marker)).toBe(false);
  });

  test("a sync through the wrapper writes its ledger under the real state home and runs no preload", () => {
    const { home, decoy, marker, cwd, env } = hostileSandbox();
    const r = run([WRAPPER, "--targets", "claude"], env, cwd);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(home, ".local", "state", "agent-hub"))).toBe(true);
    expect(existsSync(decoy)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test("install.sh run from such a directory runs no preload, including its bun helpers", () => {
    const { home, hub, decoy, marker, cwd, env } = hostileSandbox();
    const r = run(
      ["bash", INSTALL_SH, "--prefix", join(home, ".agent-hub"), "--bin-dir", join(home, ".local", "bin"), "--agents-dir", hub],
      { ...env, XDG_STATE_HOME: join(home, ".local", "state") },
      cwd,
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(decoy)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".config", "agent-hub", "config.json"), "utf8")).agentsDir).toBe(hub);
  }, 30_000);

  test("every bun invocation in bin/sync-agents and install.sh passes the isolation flags", () => {
    for (const file of [WRAPPER, INSTALL_SH]) {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("BUN_ISOLATED=(--config=/dev/null --no-env-file --tsconfig-override=/dev/null)");
      // Any line that runs bun as a command: the word "bun" as a command token, outside comments,
      // `command -v` probes and messages. Each must pass the isolation flags.
      const calls = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .filter((l) => !/command -v bun|echo |emit_error |printf /.test(l))
        .filter((l) => /(^|[\s(;&|])(exec\s+)?bun(\s|$|")/.test(l) || /\$\(command -v bun\)|"\$BUN"/.test(l));
      expect(calls.length).toBeGreaterThan(0);
      for (const l of calls) expect(l).toContain("${BUN_ISOLATED[@]}");
    }
    const runner = readFileSync(INSTALL_SH, "utf8").match(/runner=\((?:bun|env BUN_BE_BUN)[^)]*\)/g) ?? [];
    expect(runner.length).toBe(2);
    for (const r of runner) expect(r).toContain("${BUN_ISOLATED[@]}");
  });

  test("the binary is compiled without .env, bunfig.toml, tsconfig.json or package.json autoloading, by build:bin and the release workflow", () => {
    const build = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts["build:bin"] as string;
    const release = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
    // All four, explicitly: tsconfig and package.json are off by default in Bun 1.4.5, but a
    // default can change.
    for (const text of [build, release]) {
      for (const flag of ["dotenv", "bunfig", "tsconfig", "package-json"]) {
        expect(text).toContain(`--no-compile-autoload-${flag}`);
      }
    }
  });
});
