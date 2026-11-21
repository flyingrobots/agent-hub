import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_BIN = join(REPO_ROOT, "bin", "sync-agents");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

const tempRoots: string[] = [];

function makeSandbox() {
  const home = mkdtempSync(join(tmpdir(), "agent-hub-test-"));
  tempRoots.push(home);
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  mkdirSync(join(home, ".agents", "mcp"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "synced"), { recursive: true });
  mkdirSync(join(home, ".codex", "skills", ".system"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "skills"), { recursive: true });

  writeFileSync(join(home, ".agents", "AGENTS.md"), "# Test Global Rules\n");
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ userId: "keep-me", theme: "dark" }, null, 2) + "\n",
  );
  chmodSync(join(home, ".claude.json"), 0o600);

  writeFileSync(
    join(home, ".codex", "config.toml"),
    'model = "gpt-5"\n\n[tui]\nanimations = true\n',
  );
  chmodSync(join(home, ".codex", "config.toml"), 0o600);

  return { home };
}

function runCmd(cmd: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawnSync(cmd, {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent-hub sync-agents", () => {
  test("resolves hub directory with precedence: --dir > AGENTS_DIR > config.json > ~/.agents", () => {
    const { home } = makeSandbox();
    const cfgDir = join(home, ".config", "agent-hub");
    mkdirSync(cfgDir, { recursive: true });

    // 4. Default ~/.agents
    let res = runCmd([SYNC_BIN, "--print-dir"], { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, ".agents"));

    // 3. config.json
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ agentsDir: "~/custom-hub" }));
    res = runCmd([SYNC_BIN, "--print-dir"], { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, "custom-hub"));

    // 2. $AGENTS_DIR overrides config.json
    res = runCmd([SYNC_BIN, "--print-dir"], {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      AGENTS_DIR: join(home, "env-hub"),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, "env-hub"));

    // 1. --dir overrides $AGENTS_DIR
    res = runCmd([SYNC_BIN, "--dir", join(home, "cli-hub"), "--print-dir"], {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      AGENTS_DIR: join(home, "env-hub"),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, "cli-hub"));
  });

  test("installs skills, preserves tool-owned dirs, compiles MCP configs, and passes --check", () => {
    const { home } = makeSandbox();
    const srcSkill = join(home, "src-demo");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(
      join(srcSkill, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill\n---\n# Demo\n",
    );

    const mcpDir = join(home, ".agents", "mcp", "demo-mcp");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(
      join(mcpDir, "mcp.json"),
      JSON.stringify({
        mcp: { command: "/usr/local/bin/demo-mcp", args: ["serve"] },
        overrides: { codex: { env: { MODE: "codex" } } },
      }),
    );

    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

    const syncRes = runCmd([SYNC_BIN, "--skill", srcSkill], env);
    expect(syncRes.exitCode).toBe(0);

    // Rules symlinks
    expect(readlinkSync(join(home, ".claude", "CLAUDE.md"))).toBe(join(home, ".agents", "AGENTS.md"));
    expect(readlinkSync(join(home, ".codex", "AGENTS.md"))).toBe(join(home, ".agents", "AGENTS.md"));
    expect(readlinkSync(join(home, ".gemini", "GEMINI.md"))).toBe(join(home, ".agents", "AGENTS.md"));
    expect(readlinkSync(join(home, ".gemini", "config", "AGENTS.md"))).toBe(
      join(home, ".agents", "AGENTS.md"),
    );

    // Per-skill symlinks & tool-owned preservation
    expect(readlinkSync(join(home, ".claude", "skills", "demo-skill"))).toBe(
      join(home, ".agents", "skills", "demo-skill"),
    );
    expect(existsSync(join(home, ".claude", "skills", "synced"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills", ".system"))).toBe(true);

    // MCP configs compiled & surgical preservation
    const claudeCfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claudeCfg.userId).toBe("keep-me");
    expect(claudeCfg.mcpServers["demo-mcp"]).toEqual({
      type: "stdio",
      command: "/usr/local/bin/demo-mcp",
      args: ["serve"],
    });
    expect(statSync(join(home, ".claude.json")).mode & 0o777).toBe(0o600);

    const codexToml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(codexToml).toContain("[tui]");
    expect(codexToml).toContain("[mcp_servers.demo-mcp]");
    expect(codexToml).toContain('MODE = "codex"');
    expect(statSync(join(home, ".codex", "config.toml")).mode & 0o777).toBe(0o600);

    const geminiCfg = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    expect(geminiCfg.mcpServers["demo-mcp"].command).toBe("/usr/local/bin/demo-mcp");

    // --check passes
    const checkRes = runCmd([SYNC_BIN, "--check"], env);
    expect(checkRes.exitCode).toBe(0);
    expect(checkRes.stdout).toContain("everything is in sync");

    // Removing skill + MCP prunes cleanly
    rmSync(join(home, ".agents", "skills", "demo-skill"), { recursive: true, force: true });
    rmSync(mcpDir, { recursive: true, force: true });
    const pruneRes = runCmd([SYNC_BIN], env);
    expect(pruneRes.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "demo-skill"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers?.["demo-mcp"],
    ).toBeUndefined();
  });

  test("install.sh creates isolated install decoupled from source checkout", () => {
    const { home } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

    const res = runCmd(
      [INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir],
      env,
    );
    expect(res.exitCode).toBe(0);
    expect(lstatSync(join(binDir, "sync-agents")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(binDir, "sync-agents"))).toBe(join(prefix, "bin", "sync-agents"));
    expect(existsSync(join(prefix, "src", "mcp-sync.ts"))).toBe(true);
    expect(existsSync(join(home, ".agents", "skills", "agent-hub", "SKILL.md"))).toBe(true);

    const checkRes = runCmd([join(binDir, "sync-agents"), "--check"], env);
    expect(checkRes.exitCode).toBe(0);
  });
});
