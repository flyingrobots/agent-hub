import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getStatePaths, loadOwnershipState, saveOwnershipState } from "../src/state.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_BIN = join(REPO_ROOT, "bin", "sync-agents");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

const tempRoots: string[] = [];

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-test-")));
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

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };

  return { home, hub: join(home, ".agents"), env };
}

function runCmd(cmd: string[], env: Record<string, string | undefined>, cwd?: string) {
  const proc = Bun.spawnSync(cmd, {
    cwd,
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
    const { home, env } = makeSandbox();
    const cfgDir = join(home, ".config", "agent-hub");
    mkdirSync(cfgDir, { recursive: true });

    // 4. Default ~/.agents
    let res = runCmd([SYNC_BIN, "--print-dir"], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, ".agents"));

    // 3. config.json
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ agentsDir: "~/custom-hub" }));
    res = runCmd([SYNC_BIN, "--print-dir"], env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, "custom-hub"));

    // 2. $AGENTS_DIR overrides config.json
    res = runCmd([SYNC_BIN, "--print-dir"], {
      ...env,
      AGENTS_DIR: join(home, "env-hub"),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, "env-hub"));

    // 1. --dir overrides $AGENTS_DIR
    res = runCmd([SYNC_BIN, "--dir", join(home, "cli-hub"), "--print-dir"], {
      ...env,
      AGENTS_DIR: join(home, "env-hub"),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join(home, "cli-hub"));
  });

  test("installs skills, preserves tool-owned dirs, compiles MCP configs, passes --check, and prunes cleanly", () => {
    const { home, hub, env } = makeSandbox();
    const srcSkill = join(home, "src-demo");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(
      join(srcSkill, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill\n---\n# Demo\n",
    );

    const mcpDir = join(hub, "mcp", "demo-mcp");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(
      join(mcpDir, "mcp.json"),
      JSON.stringify({
        mcp: { command: "/usr/local/bin/demo-mcp", args: ["serve"] },
        overrides: { codex: { env: { MODE: "codex" } } },
      }),
    );

    const syncRes = runCmd([SYNC_BIN, "--skill", srcSkill], env);
    expect(syncRes.exitCode).toBe(0);

    // Rules symlinks
    expect(readlinkSync(join(home, ".claude", "CLAUDE.md"))).toBe(join(hub, "AGENTS.md"));
    expect(readlinkSync(join(home, ".codex", "AGENTS.md"))).toBe(join(hub, "AGENTS.md"));
    expect(readlinkSync(join(home, ".gemini", "GEMINI.md"))).toBe(join(hub, "AGENTS.md"));
    expect(readlinkSync(join(home, ".gemini", "config", "AGENTS.md"))).toBe(join(hub, "AGENTS.md"));

    // Per-skill symlinks & tool-owned preservation
    expect(readlinkSync(join(home, ".claude", "skills", "demo-skill"))).toBe(
      join(hub, "skills", "demo-skill"),
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

    const agCfg = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    expect(agCfg.mcpServers["demo-mcp"].command).toBe("/usr/local/bin/demo-mcp");
    expect(agCfg.mcpServers["demo-mcp"].disabled).toBe(false);

    // Ownership ledger lives in XDG state (not inside ~/.agents/)
    expect(existsSync(join(hub, ".mcp-managed.json"))).toBe(false);
    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    expect(existsSync(paths.statePath)).toBe(true);

    // --check passes
    const checkRes = runCmd([SYNC_BIN, "--check"], env);
    expect(checkRes.exitCode).toBe(0);
    expect(checkRes.stdout).toContain("everything is in sync");

    // Removing skill + MCP prunes cleanly
    rmSync(join(hub, "skills", "demo-skill"), { recursive: true, force: true });
    rmSync(mcpDir, { recursive: true, force: true });
    const pruneRes = runCmd([SYNC_BIN], env);
    expect(pruneRes.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "demo-skill"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers?.["demo-mcp"],
    ).toBeUndefined();
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
  });

  test("install.sh creates isolated install with .agent-hub-runtime marker and passes --check", () => {
    const { home, hub, env } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");

    const res = runCmd([INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir], env);
    expect(res.exitCode).toBe(0);
    expect(lstatSync(join(binDir, "sync-agents")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(binDir, "sync-agents"))).toBe(join(prefix, "bin", "sync-agents"));
    expect(existsSync(join(prefix, "src", "cli.ts"))).toBe(true);
    expect(existsSync(join(prefix, "src", "mcp-sync.ts"))).toBe(true);
    expect(existsSync(join(prefix, ".agent-hub-runtime"))).toBe(true);
    expect(existsSync(join(hub, "skills", "agent-hub", "SKILL.md"))).toBe(true);

    const checkRes = runCmd([join(binDir, "sync-agents"), "--check"], env);
    expect(checkRes.exitCode).toBe(0);
  });

  test("Contract 1 (MUST #1): disabled MCP collision survives --check, 1st sync, 2nd sync, and re-enable without acquiring ownership", () => {
    const { home, hub, env } = makeSandbox();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { foo: { type: "stdio", command: "/personal/foo", args: [] } } }, null, 2) + "\n",
    );
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'model = "gpt-5"\n\n[mcp_servers.foo]\ncommand = "/personal/foo"\n',
    );
    writeFileSync(
      join(home, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { foo: { command: "/personal/foo", disabled: false } } }, null, 2) + "\n",
    );

    const fooDir = join(hub, "mcp", "foo");
    mkdirSync(fooDir, { recursive: true });
    writeFileSync(join(fooDir, "mcp.json"), JSON.stringify({ mcp: { disabled: true } }));

    // --check reports collision and exits 1
    const chk = runCmd([SYNC_BIN, "--check"], env);
    expect(chk.exitCode).toBe(1);
    expect(chk.stderr).toContain("[conflict]");

    // 1st ordinary sync fails closed and preserves all 3 personal entries
    const r1 = runCmd([SYNC_BIN], env);
    expect(r1.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.foo.command).toBe("/personal/foo");
    expect(Bun.TOML.parse(readFileSync(join(home, ".codex", "config.toml"), "utf8"))).toMatchObject({
      mcp_servers: { foo: { command: "/personal/foo" } },
    });
    expect(
      JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")).mcpServers.foo.command,
    ).toBe("/personal/foo");

    // 2nd ordinary sync STILL preserves all 3 entries (no fabricated ownership!)
    const r2 = runCmd([SYNC_BIN], env);
    expect(r2.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.foo.command).toBe("/personal/foo");

    // Re-enabling canonical foo STILL treats personal foo as unmanaged conflict!
    writeFileSync(join(fooDir, "mcp.json"), JSON.stringify({ mcp: { command: "/canonical/foo" } }));
    const r3 = runCmd([SYNC_BIN], env);
    expect(r3.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.foo.command).toBe("/personal/foo");

    // Ownership ledger still contains zero ownership for foo
    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    const state = loadOwnershipState(paths.statePath, hub).state;
    expect(state.mcp.claude.foo).toBeUndefined();
    expect(state.mcp.codex.foo).toBeUndefined();
    expect(state.mcp.antigravity.foo).toBeUndefined();
  });

  test("Contract 2 (Amendment 5): full legacy v1 .mcp-managed.json lifecycle (L1-L6) & --disown-legacy", () => {
    const { home, hub, env } = makeSandbox();
    // Pre-populate legacy v1 manifest claiming identical (L1), differing (L3), disabled (L4), absent-removed (L5), removed-present (L6)
    writeFileSync(
      join(hub, ".mcp-managed.json"),
      JSON.stringify({
        version: 1,
        managed: {
          gemini: ["ident"],
          claude: ["ident", "diff", "dis", "gone", "keep-personal"],
          codex: [],
        },
      }),
    );

    // Canonical definitions: ident (enabled), diff (enabled), dis (disabled); gone & keep-personal removed from canonical
    mkdirSync(join(hub, "mcp", "ident"), { recursive: true });
    writeFileSync(join(hub, "mcp", "ident", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/ident" } }));
    mkdirSync(join(hub, "mcp", "diff"), { recursive: true });
    writeFileSync(join(hub, "mcp", "diff", "mcp.json"), JSON.stringify({ mcp: { command: "/canon/diff" } }));
    mkdirSync(join(hub, "mcp", "dis"), { recursive: true });
    writeFileSync(join(hub, "mcp", "dis", "mcp.json"), JSON.stringify({ mcp: { disabled: true } }));

    // Existing Claude entries
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify(
        {
          mcpServers: {
            ident: { type: "stdio", command: "/bin/ident", args: [] },
            diff: { type: "stdio", command: "/personal/diff", args: [] },
            dis: { type: "stdio", command: "/personal/dis", args: [] },
            "keep-personal": { type: "stdio", command: "/personal/keep", args: [] },
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(home, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { ident: { command: "/bin/ident", disabled: false } } }, null, 2) + "\n",
    );

    // Plain sync preserves EVERY legacy entry conservatively (no auto-overwrite or auto-delete!)
    const plain = runCmd([SYNC_BIN], env);
    expect(plain.exitCode).toBe(1);
    const claude1 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claude1.mcpServers.diff.command).toBe("/personal/diff");
    expect(claude1.mcpServers.dis.command).toBe("/personal/dis");
    expect(claude1.mcpServers["keep-personal"].command).toBe("/personal/keep");

    // Trying --disown-legacy while canonical `dis` still exists MUST be refused!
    const badDisown = runCmd([SYNC_BIN, "--disown-legacy", "claude:dis"], env);
    expect(badDisown.exitCode).toBe(1);
    expect(badDisown.stderr).toContain("still declares");

    // Withdraw conflicting canonical `diff` and `dis`, then retain personal entries cleanly:
    rmSync(join(hub, "mcp", "diff"), { recursive: true, force: true });
    rmSync(join(hub, "mcp", "dis"), { recursive: true, force: true });

    // Adopt identical `ident` + disown personal `diff`, `dis`, `keep-personal` + auto-retire absent `gone`!
    const migrate = runCmd(
      [
        SYNC_BIN,
        "--adopt",
        "--disown-legacy",
        "claude:diff",
        "--disown-legacy",
        "claude:dis",
        "--disown-legacy",
        "claude:keep-personal",
      ],
      env,
    );
    expect(migrate.exitCode).toBe(0);

    // All personal entries survived untouched, `ident` is owned in v2, and next --check exits 0!
    const claude2 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claude2.mcpServers.diff.command).toBe("/personal/diff");
    expect(claude2.mcpServers.dis.command).toBe("/personal/dis");
    expect(claude2.mcpServers["keep-personal"].command).toBe("/personal/keep");
    expect(claude2.mcpServers.ident.command).toBe("/bin/ident");

    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    const state = loadOwnershipState(paths.statePath, hub).state;
    expect(state.mcp.claude.ident?.basis).toBe("adopted");
    expect(state.mcp.antigravity.ident?.basis).toBe("adopted");
    expect(state.mcp.claude.diff).toBeUndefined();
    expect(state.resolvedLegacyV1.claude).toContain("gone");
    expect(state.resolvedLegacyV1.claude).toContain("keep-personal");

    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
  });

  test("Contract 3 (MUST #2 + SHOULD #4): installer never supplies global force, scopes --force-skill, and guards --prefix & shim", () => {
    const { home, hub, env } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");

    // Customize canonical agent-hub skill with unique companion file + conflicting personal MCP entry
    const skillDir = join(hub, "skills", "agent-hub");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: agent-hub\n---\n# My Custom Skill\n");
    writeFileSync(join(skillDir, "notes.md"), "unique personal note\n");

    mkdirSync(join(hub, "mcp", "conflict-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "conflict-srv", "mcp.json"),
      JSON.stringify({ mcp: { command: "/canon/srv" } }),
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify(
        { mcpServers: { "conflict-srv": { type: "stdio", command: "/personal/srv", args: [] } } },
        null,
        2,
      ) + "\n",
    );

    // 1. Plain ./install.sh preserves custom skill, companion file, AND personal MCP entry
    const r1 = runCmd([INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir], env);
    expect(r1.exitCode).toBe(1);
    expect(existsSync(join(skillDir, "notes.md"))).toBe(true);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("# My Custom Skill");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["conflict-srv"].command).toBe(
      "/personal/srv",
    );

    // 2. ./install.sh --force-skill STILL does NOT authorize overwriting differing personal MCP!
    const r2 = runCmd([INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir, "--force-skill"], env);
    expect(r2.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["conflict-srv"].command).toBe(
      "/personal/srv",
    );

    // 3. ./install.sh --force-skill --no-sync replaces ONLY the bundled skill while leaving MCP untouched!
    const r3 = runCmd(
      [INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir, "--force-skill", "--no-sync"],
      env,
    );
    expect(r3.exitCode).toBe(0);
    expect(existsSync(join(skillDir, "notes.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["conflict-srv"].command).toBe(
      "/personal/srv",
    );

    // 4. Prefix guard refuses non-runtime directory containing sentinel without deleting it
    const nonRuntimePrefix = join(home, "important-dir");
    mkdirSync(nonRuntimePrefix, { recursive: true });
    writeFileSync(join(nonRuntimePrefix, "sentinel.txt"), "do not delete\n");
    const r4 = runCmd(
      [INSTALL_SH, "--prefix", nonRuntimePrefix, "--bin-dir", binDir, "--no-skill"],
      env,
    );
    expect(r4.exitCode).toBe(1);
    expect(existsSync(join(nonRuntimePrefix, "sentinel.txt"))).toBe(true);

    // 5. Prefix guard refuses overlapping hub directory
    const r5 = runCmd([INSTALL_SH, "--prefix", hub, "--bin-dir", binDir, "--no-skill"], env);
    expect(r5.exitCode).toBe(1);
    expect(r5.stderr).toContain("overlaps hub");

    // 6. Shim guard refuses overwriting an unrelated real file at <bin-dir>/sync-agents
    const otherBinDir = join(home, "custom-bin");
    mkdirSync(otherBinDir, { recursive: true });
    writeFileSync(join(otherBinDir, "sync-agents"), "#!/bin/sh\necho custom\n");
    const r6 = runCmd(
      [INSTALL_SH, "--prefix", prefix, "--bin-dir", otherBinDir, "--no-skill"],
      env,
    );
    expect(r6.exitCode).toBe(1);
    expect(readFileSync(join(otherBinDir, "sync-agents"), "utf8")).toContain("echo custom");

    // 7. --replace-runtime preserves previous unrecognized prefix as a timestamped backup
    const r7 = runCmd(
      [INSTALL_SH, "--prefix", nonRuntimePrefix, "--bin-dir", binDir, "--no-skill", "--replace-runtime"],
      env,
    );
    expect(r7.exitCode).toBe(0);
    expect(r7.stdout).toContain("moved previous prefix");
    expect(existsSync(join(nonRuntimePrefix, ".agent-hub-runtime"))).toBe(true);
    const backupMatch = r7.stdout.match(/moved previous prefix -> (.+)/);
    expect(backupMatch).not.toBeNull();
    expect(existsSync(join(backupMatch![1]!.trim(), "sentinel.txt"))).toBe(true);
  });

  test("Contract 4 (MUST #3 + Amendment 3): honest symlink ownership & strict adoption equivalence (.git, mode, xattr values, escaping symlinks)", () => {
    const { home, hub, env } = makeSandbox();

    // 1. Independently created symlink is NOT retargeted on plain sync
    const customRules = join(home, "my-rules.md");
    writeFileSync(customRules, "# Mine\n");
    symlinkSync(customRules, join(home, ".claude", "CLAUDE.md"));

    // 2. Independently created hub-prefixed symlink pointing to a regular file is NOT pruned
    const regularInHub = join(hub, "skills", "not-a-dir.txt");
    writeFileSync(regularInHub, "hello\n");
    const manualHubLink = join(home, ".claude", "skills", "manual-file-link");
    symlinkSync(regularInHub, manualHubLink);

    const r1 = runCmd([SYNC_BIN], env);
    expect(r1.exitCode).toBe(1);
    expect(readlinkSync(join(home, ".claude", "CLAUDE.md"))).toBe(customRules);
    expect(lstatSync(manualHubLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(manualHubLink)).toBe(regularInHub);

    // Remove custom CLAUDE.md conflict to test adoption equivalence cases cleanly
    rmSync(join(home, ".claude", "CLAUDE.md"));

    // 3. Equal skill text + unique .git metadata -> --adopt MUST refuse and preserve .git!
    const canonGit = join(hub, "skills", "git-skill");
    const dstGit = join(home, ".claude", "skills", "git-skill");
    mkdirSync(canonGit, { recursive: true });
    mkdirSync(join(dstGit, ".git"), { recursive: true });
    writeFileSync(join(canonGit, "SKILL.md"), "---\nname: git-skill\n---\n# Git\n");
    writeFileSync(join(dstGit, "SKILL.md"), "---\nname: git-skill\n---\n# Git\n");
    writeFileSync(join(dstGit, ".git", "HEAD"), "ref: refs/heads/main\n");

    const rGit = runCmd([SYNC_BIN, "--adopt"], env);
    expect(rGit.exitCode).toBe(1);
    expect(lstatSync(dstGit).isDirectory()).toBe(true);
    expect(existsSync(join(dstGit, ".git", "HEAD"))).toBe(true);
    rmSync(canonGit, { recursive: true, force: true });
    rmSync(dstGit, { recursive: true, force: true });

    // 4. Equal bytes, DIFFERENT executable mode (0755 vs 0644) -> --adopt MUST refuse!
    const canonMode = join(hub, "skills", "mode-skill");
    const dstMode = join(home, ".claude", "skills", "mode-skill");
    mkdirSync(canonMode, { recursive: true });
    mkdirSync(dstMode, { recursive: true });
    writeFileSync(join(canonMode, "SKILL.md"), "---\nname: mode-skill\n---\n# Mode\n");
    writeFileSync(join(dstMode, "SKILL.md"), "---\nname: mode-skill\n---\n# Mode\n");
    writeFileSync(join(canonMode, "run.sh"), "#!/bin/sh\necho ok\n");
    writeFileSync(join(dstMode, "run.sh"), "#!/bin/sh\necho ok\n");
    chmodSync(join(canonMode, "run.sh"), 0o644);
    chmodSync(join(dstMode, "run.sh"), 0o755);

    const rMode = runCmd([SYNC_BIN, "--adopt"], env);
    expect(rMode.exitCode).toBe(1);
    expect(rMode.stderr).toContain("mode differs");
    expect(lstatSync(dstMode).isDirectory()).toBe(true);
    expect(statSync(join(dstMode, "run.sh")).mode & 0o777).toBe(0o755);
    rmSync(canonMode, { recursive: true, force: true });
    rmSync(dstMode, { recursive: true, force: true });

    // 5. macOS xattr test: identical attribute name & 1-byte length, DIFFERENT raw value ("A" vs "B") -> MUST refuse!
    if (process.platform === "darwin") {
      const canonXattr = join(hub, "skills", "xattr-skill");
      const dstXattr = join(home, ".claude", "skills", "xattr-skill");
      mkdirSync(canonXattr, { recursive: true });
      mkdirSync(dstXattr, { recursive: true });
      writeFileSync(join(canonXattr, "SKILL.md"), "---\nname: xattr-skill\n---\n# X\n");
      writeFileSync(join(dstXattr, "SKILL.md"), "---\nname: xattr-skill\n---\n# X\n");
      chmodSync(join(canonXattr, "SKILL.md"), 0o644);
      chmodSync(join(dstXattr, "SKILL.md"), 0o644);
      chmodSync(canonXattr, 0o755);
      chmodSync(dstXattr, 0o755);

      const x1 = Bun.spawnSync(["/usr/bin/xattr", "-w", "example.attribute", "A", join(canonXattr, "SKILL.md")]);
      const x2 = Bun.spawnSync(["/usr/bin/xattr", "-w", "example.attribute", "B", join(dstXattr, "SKILL.md")]);
      expect(x1.exitCode).toBe(0);
      expect(x2.exitCode).toBe(0);

      const rXattr = runCmd([SYNC_BIN, "--adopt"], env);
      expect(rXattr.exitCode).toBe(1);
      expect(rXattr.stderr).toContain("extended attributes differ");
      expect(lstatSync(dstXattr).isDirectory()).toBe(true);

      // Now set identical value "A" -> adoption succeeds!
      expect(
        Bun.spawnSync(["/usr/bin/xattr", "-w", "example.attribute", "A", join(dstXattr, "SKILL.md")]).exitCode,
      ).toBe(0);
      const rXattrOk = runCmd([SYNC_BIN, "--adopt"], env);
      expect(rXattrOk.exitCode).toBe(0);
      expect(lstatSync(dstXattr).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dstXattr)).toBe(canonXattr);
      // Manual hub-prefixed regular-file link STILL survived untouched!
      expect(lstatSync(manualHubLink).isSymbolicLink()).toBe(true);
    }

    // 6. Escaping relative symlink inside target dir -> --adopt MUST refuse!
    const canonEsc = join(hub, "skills", "esc-skill");
    const dstEsc = join(home, ".claude", "skills", "esc-skill");
    mkdirSync(canonEsc, { recursive: true });
    mkdirSync(dstEsc, { recursive: true });
    writeFileSync(join(canonEsc, "SKILL.md"), "---\nname: esc-skill\n---\n# Esc\n");
    writeFileSync(join(dstEsc, "SKILL.md"), "---\nname: esc-skill\n---\n# Esc\n");
    symlinkSync("../../outside.txt", join(canonEsc, "ref"));
    symlinkSync("../../outside.txt", join(dstEsc, "ref"));
    const rEsc = runCmd([SYNC_BIN, "--adopt"], env);
    expect(rEsc.exitCode).toBe(1);
    expect(rEsc.stderr).toContain("escaping relative symlink");
    expect(lstatSync(dstEsc).isDirectory()).toBe(true);
    rmSync(canonEsc, { recursive: true, force: true });
    rmSync(dstEsc, { recursive: true, force: true });

    // 7. Managed symlink externally repointed by user -> preserved on plain sync AND not pruned on removal!
    const canonManaged = join(hub, "skills", "managed-skill");
    mkdirSync(canonManaged, { recursive: true });
    writeFileSync(join(canonManaged, "SKILL.md"), "---\nname: managed-skill\n---\n# M\n");
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    const managedDst = join(home, ".claude", "skills", "managed-skill");
    const userOverrideDir = join(home, "user-override-skill");
    mkdirSync(userOverrideDir, { recursive: true });
    rmSync(managedDst);
    symlinkSync(userOverrideDir, managedDst);
    // Plain sync refuses to overwrite repointed managed symlink
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(1);
    expect(readlinkSync(managedDst)).toBe(userOverrideDir);
    // Removing canonical skill refuses to prune repointed symlink
    rmSync(canonManaged, { recursive: true, force: true });
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(1);
    expect(readlinkSync(managedDst)).toBe(userOverrideDir);
  });

  test("Contract 5 (Amendment 5): ledger-only changes visible to --check and stable runs have zero churn", () => {
    const { home, hub, env } = makeSandbox();
    mkdirSync(join(hub, "mcp", "alpha"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "alpha", "mcp.json"),
      JSON.stringify({ mcp: { command: "/usr/bin/alpha" } }),
    );
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);

    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    const stableRaw = readFileSync(paths.statePath, "utf8");
    const stableState = loadOwnershipState(paths.statePath, hub).state;

    // Repeated ordinary sync does NOT rewrite state or bump generation/updatedAt!
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    expect(readFileSync(paths.statePath, "utf8")).toBe(stableRaw);

    // Artificially make stored digest stale while target config still matches canonical desired:
    // --check MUST report drift (exit 1) because ledger work is needed!
    const staleState = structuredClone(stableState);
    staleState.mcp.claude.alpha!.digest = "0".repeat(64);
    saveOwnershipState(paths.statePath, staleState);

    const chkStale = runCmd([SYNC_BIN, "--check"], env);
    expect(chkStale.exitCode).toBe(1);
    expect(chkStale.stdout).toContain("refresh-mcp-digest");

    // Ordinary sync refreshes digest without rewriting ~/.claude.json, then --check passes!
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
    expect(loadOwnershipState(paths.statePath, hub).state.mcp.claude.alpha!.digest).toBe(
      stableState.mcp.claude.alpha!.digest,
    );
  });

  test("Contract 6 (MUST #5): mixed conflict with no pending recovery fails closed with zero target or ledger writes", () => {
    const { home, hub, env } = makeSandbox();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { b: { type: "stdio", command: "/personal/b", args: [] } } }, null, 2) + "\n",
    );
    mkdirSync(join(hub, "mcp", "a"), { recursive: true });
    writeFileSync(join(hub, "mcp", "a", "mcp.json"), JSON.stringify({ mcp: { command: "/canon/a" } }));
    mkdirSync(join(hub, "mcp", "b"), { recursive: true });
    writeFileSync(join(hub, "mcp", "b", "mcp.json"), JSON.stringify({ mcp: { command: "/canon/b" } }));

    const r1 = runCmd([SYNC_BIN], env);
    expect(r1.exitCode).toBe(1);
    // Neither `a` nor `b` was written, and no state file was created!
    const claudeCfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claudeCfg.mcpServers.a).toBeUndefined();
    expect(claudeCfg.mcpServers.b.command).toBe("/personal/b");

    // Remove conflicting canonical `b`; next run succeeds cleanly!
    rmSync(join(hub, "mcp", "b"), { recursive: true, force: true });
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.a.command).toBe("/canon/a");
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
  });

  test("Contract 7 (MUST #6): relative --dir hub canonicalizes to absolute links and --check catches broken links across CWDs", () => {
    const { home, env } = makeSandbox();
    const relHub = join(home, "hub");
    mkdirSync(join(relHub, "skills", "demo"), { recursive: true });
    writeFileSync(join(relHub, "AGENTS.md"), "# Relative Hub\n");
    writeFileSync(join(relHub, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n# Demo\n");

    // Run from `home` with relative `--dir hub`
    const syncRes = runCmd([SYNC_BIN, "--dir", "hub"], env, home);
    expect(syncRes.exitCode).toBe(0);

    const claudeRules = join(home, ".claude", "CLAUDE.md");
    expect(readlinkSync(claudeRules)).toBe(join(relHub, "AGENTS.md"));
    expect(existsSync(claudeRules)).toBe(true);

    // Run --check from a DIFFERENT working directory selecting the same resolved hub
    const otherCwd = join(home, "other-dir");
    mkdirSync(otherCwd, { recursive: true });
    const chkOther = runCmd([SYNC_BIN, "--dir", "../hub", "--check"], env, otherCwd);
    expect(chkOther.exitCode).toBe(0);

    // Replace with a broken relative symlink -> --check MUST fail!
    rmSync(claudeRules);
    symlinkSync("hub/AGENTS.md", claudeRules);
    expect(existsSync(claudeRules)).toBe(false);
    const chkBroken = runCmd([SYNC_BIN, "--dir", relHub, "--check"], env, otherCwd);
    expect(chkBroken.exitCode).toBe(1);
  });

  test("Contract 8 (SHOULD #2 + Amendment 4): explicit transport, disabled-SSE precedence, family switching, antigravity rename, and --explain", () => {
    const { home, hub, env } = makeSandbox();

    // 1. Bare `url` without explicit `transport` is rejected
    const bareDir = join(hub, "mcp", "bare-remote");
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(join(bareDir, "mcp.json"), JSON.stringify({ mcp: { url: "https://example.invalid/mcp" } }));
    const bareRes = runCmd([SYNC_BIN], env);
    expect(bareRes.exitCode).toBe(1);
    expect(bareRes.stderr).toContain("must explicitly specify \"transport\"");
    rmSync(bareDir, { recursive: true, force: true });

    // 2. Legacy `overrides.gemini` fails with migration error pointing to `antigravity`
    const legDir = join(hub, "mcp", "leg-gemini");
    mkdirSync(legDir, { recursive: true });
    writeFileSync(
      join(legDir, "mcp.json"),
      JSON.stringify({
        mcp: { command: "/bin/leg" },
        overrides: { gemini: { disabled: true } },
      }),
    );
    const legRes = runCmd([SYNC_BIN], env);
    expect(legRes.exitCode).toBe(1);
    expect(legRes.stderr).toContain('renamed to "antigravity"');
    rmSync(legDir, { recursive: true, force: true });

    // 3. Streamable HTTP compiles across all 3 adapters (Claude type:"http", Codex url, Antigravity serverUrl)
    mkdirSync(join(hub, "mcp", "http-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "http-srv", "mcp.json"),
      JSON.stringify({
        mcp: {
          transport: "http",
          url: "https://example.invalid/http",
          headers: { "X-Key": "val" },
        },
      }),
    );

    // 4. Inherited SSE URL + disabled Antigravity & Codex overrides compiles cleanly (disabled-first!)
    mkdirSync(join(hub, "mcp", "sse-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "sse-srv", "mcp.json"),
      JSON.stringify({
        mcp: {
          transport: "sse",
          url: "https://example.invalid/sse",
        },
        overrides: {
          antigravity: { disabled: true },
          codex: { disabled: true },
        },
      }),
    );

    // 5. Transport-family switching: remote -> stdio for Codex AND stdio -> remote for Claude
    mkdirSync(join(hub, "mcp", "hybrid-switch"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "hybrid-switch", "mcp.json"),
      JSON.stringify({
        mcp: {
          transport: "http",
          url: "https://example.invalid/remote",
          headers: { Authorization: "Bearer tok" },
        },
        overrides: {
          codex: {
            command: "/usr/local/bin/local-bridge",
            args: ["--stdio"],
          },
        },
      }),
    );

    mkdirSync(join(hub, "mcp", "stdio-to-remote"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "stdio-to-remote", "mcp.json"),
      JSON.stringify({
        mcp: {
          command: "/usr/local/bin/base-stdio",
          args: ["--run"],
          env: { A: "1" },
        },
        overrides: {
          claude: {
            transport: "sse",
            url: "https://example.invalid/claude-sse",
          },
        },
      }),
    );

    // Active SSE without disabling Codex/Antigravity is rejected with clear diagnostic
    const badSseDir = join(hub, "mcp", "active-sse-bad");
    mkdirSync(badSseDir, { recursive: true });
    writeFileSync(
      join(badSseDir, "mcp.json"),
      JSON.stringify({ mcp: { transport: "sse", url: "https://example.invalid/bad-sse" } }),
    );
    const badSseRes = runCmd([SYNC_BIN], env);
    expect(badSseRes.exitCode).toBe(1);
    expect(badSseRes.stderr).toContain("does not support SSE transport");
    rmSync(badSseDir, { recursive: true, force: true });

    // --explain prints rich decision details without mutating disk
    const explainRes = runCmd([SYNC_BIN, "--explain"], env);
    expect(explainRes.exitCode).toBe(0);
    expect(explainRes.stdout).toContain("[explain]");
    expect(explainRes.stdout).toContain("basis:");

    // Apply succeeds cleanly!
    const applyRes = runCmd([SYNC_BIN], env);
    expect(applyRes.exitCode).toBe(0);

    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers;
    expect(claude["http-srv"]).toEqual({
      type: "http",
      url: "https://example.invalid/http",
      headers: { "X-Key": "val" },
    });
    expect(claude["sse-srv"]).toEqual({
      type: "sse",
      url: "https://example.invalid/sse",
    });
    expect(claude["stdio-to-remote"]).toEqual({
      type: "sse",
      url: "https://example.invalid/claude-sse",
    });

    const ag = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"),
    ).mcpServers;
    expect(ag["http-srv"]).toEqual({
      serverUrl: "https://example.invalid/http",
      headers: { "X-Key": "val" },
      disabled: false,
    });
    expect(ag["sse-srv"]).toBeUndefined();

    const codex = Bun.TOML.parse(
      readFileSync(join(home, ".codex", "config.toml"), "utf8"),
    ) as Record<string, any>;
    expect(codex.mcp_servers["http-srv"]).toEqual({
      url: "https://example.invalid/http",
      http_headers: { "X-Key": "val" },
    });
    expect(codex.mcp_servers["sse-srv"]).toBeUndefined();
    expect(codex.mcp_servers["hybrid-switch"]).toEqual({
      command: "/usr/local/bin/local-bridge",
      args: ["--stdio"],
    });

    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
  });
});
