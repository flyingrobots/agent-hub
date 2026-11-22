import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getStatePaths, loadOwnershipState } from "../src/state.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_BIN = join(REPO_ROOT, "bin", "sync-agents");
const tempRoots: string[] = [];

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-p1-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "skills"), { recursive: true });
  mkdirSync(join(hub, "mcp"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "skills"), { recursive: true });
  mkdirSync(join(home, ".cursor", "skills"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode", "skills"), { recursive: true });

  writeFileSync(join(hub, "AGENTS.md"), "# Rules\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ userId: "u1" }, null, 2) + "\n");
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

function runCmd(cmd: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawnSync(cmd, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
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
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 1: Cursor & OpenCode adapters, --targets/disabledTargets, and universal JSONC guard", () => {
  test("Cursor and OpenCode compile stdio/http/sse, preserve unrelated keys & 0600 mode, pass --check, and prune cleanly", () => {
    const { home, hub, env } = makeSandbox();

    // Pre-existing unrelated keys in both configs
    const cursorPath = join(home, ".cursor", "mcp.json");
    writeFileSync(cursorPath, JSON.stringify({ customMeta: "stay" }, null, 2) + "\n");
    chmodSync(cursorPath, 0o600);

    const ocPath = join(home, ".config", "opencode", "opencode.json");
    writeFileSync(
      ocPath,
      JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "claude-sonnet" }, null, 2) +
        "\n",
    );
    chmodSync(ocPath, 0o600);

    // 1. stdio server with per-agent overrides
    mkdirSync(join(hub, "mcp", "local-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "local-srv", "mcp.json"),
      JSON.stringify({
        mcp: { command: "/usr/bin/local-srv", args: ["--flag"], env: { BASE: "1" } },
        overrides: {
          cursor: { env: { CUR: "yes" } },
          opencode: { env: { OC: "yes" } },
        },
      }),
    );

    // 2. SSE server (supported by Cursor, OpenCode, Claude; disabled on Antigravity & Codex)
    mkdirSync(join(hub, "mcp", "sse-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "sse-srv", "mcp.json"),
      JSON.stringify({
        mcp: {
          transport: "sse",
          url: "https://example.invalid/sse",
          headers: { "X-Client": "agent-hub" },
        },
        overrides: {
          antigravity: { disabled: true },
          codex: { disabled: true },
        },
      }),
    );

    const syncRes = runCmd([SYNC_BIN], env);
    expect(syncRes.exitCode).toBe(0);

    const cursorCfg = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(cursorCfg.customMeta).toBe("stay");
    expect(cursorCfg.mcpServers["local-srv"]).toEqual({
      type: "stdio",
      command: "/usr/bin/local-srv",
      args: ["--flag"],
      env: { BASE: "1", CUR: "yes" },
    });
    expect(cursorCfg.mcpServers["sse-srv"]).toEqual({
      url: "https://example.invalid/sse",
      headers: { "X-Client": "agent-hub" },
    });
    expect(statSync(cursorPath).mode & 0o777).toBe(0o600);

    const ocCfg = JSON.parse(readFileSync(ocPath, "utf8"));
    expect(ocCfg.$schema).toBe("https://opencode.ai/config.json");
    expect(ocCfg.model).toBe("claude-sonnet");
    expect(ocCfg.mcp["local-srv"]).toEqual({
      type: "local",
      command: ["/usr/bin/local-srv", "--flag"],
      environment: { BASE: "1", OC: "yes" },
      enabled: true,
    });
    expect(ocCfg.mcp["sse-srv"]).toEqual({
      type: "remote",
      url: "https://example.invalid/sse",
      headers: { "X-Client": "agent-hub" },
      enabled: true,
    });
    expect(statSync(ocPath).mode & 0o777).toBe(0o600);

    // --check passes cleanly
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);

    // Removing canonical servers prunes cleanly from Cursor and OpenCode
    rmSync(join(hub, "mcp", "local-srv"), { recursive: true, force: true });
    rmSync(join(hub, "mcp", "sse-srv"), { recursive: true, force: true });
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers).toEqual({});
    expect(JSON.parse(readFileSync(ocPath, "utf8")).mcp).toEqual({});
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
  });

  test("--targets and config disabledTargets skip untargeted adapters and NEVER prune them", () => {
    const { home, hub, env } = makeSandbox();
    mkdirSync(join(hub, "skills", "demo-skill"), { recursive: true });
    writeFileSync(join(hub, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\n---\n# D\n");
    mkdirSync(join(hub, "mcp", "demo"), { recursive: true });
    writeFileSync(join(hub, "mcp", "demo", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/demo" } }));

    // Sync all 5 targets initially
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    const cursorLink = join(home, ".cursor", "skills", "demo-skill");
    const cursorMcp = join(home, ".cursor", "mcp.json");
    expect(lstatSync(cursorLink).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(cursorMcp, "utf8")).mcpServers.demo.command).toBe("/bin/demo");

    // Remove canonical skill & MCP, then sync ONLY --targets claude:
    // Claude is pruned, while untargeted Cursor MUST remain completely untouched (NOT pruned)!
    rmSync(join(hub, "skills", "demo-skill"), { recursive: true, force: true });
    rmSync(join(hub, "mcp", "demo"), { recursive: true, force: true });
    const partialRes = runCmd([SYNC_BIN, "--targets", "claude"], env);
    expect(partialRes.exitCode).toBe(0);

    expect(existsSync(join(home, ".claude", "skills", "demo-skill"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.demo).toBeUndefined();
    // Cursor's link, MCP entry, AND ledger records are preserved verbatim!
    expect(lstatSync(cursorLink).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(cursorMcp, "utf8")).mcpServers.demo.command).toBe("/bin/demo");
    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    const state = loadOwnershipState(paths.statePath, hub).state;
    expect(state.links[cursorLink]).toBeDefined();
    expect(state.mcp.cursor.demo).toBeDefined();

    // config.json disabledTargets opts out permanently; explicit --targets overrides disabledTargets
    const cfgDir = join(home, ".config", "agent-hub");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ disabledTargets: ["cursor", "opencode"] }),
    );
    // Add conflicting entry to ~/.cursor/mcp.json; plain sync skips cursor & succeeds!
    writeFileSync(
      cursorMcp,
      JSON.stringify({ mcpServers: { conflicting: { type: "stdio", command: "/other" } } }),
    );
    mkdirSync(join(hub, "mcp", "conflicting"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "conflicting", "mcp.json"),
      JSON.stringify({ mcp: { command: "/canon" } }),
    );
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    // Explicit --targets cursor overrides disabledTargets and surfaces the conflict!
    expect(runCmd([SYNC_BIN, "--targets", "cursor"], env).exitCode).toBe(1);
    // Unknown target exits 2
    const badTarget = runCmd([SYNC_BIN, "--targets", "nonexistent"], env);
    expect(badTarget.exitCode).toBe(2);
    expect(badTarget.stderr).toContain('unknown target "nonexistent"');
  });

  test("universal JSONC guard rejects .jsonc siblings and commented JSON across all JSON adapters without breaking https:// URLs", () => {
    const { home, hub, env } = makeSandbox();
    mkdirSync(join(hub, "mcp", "remote-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "remote-srv", "mcp.json"),
      JSON.stringify({
        mcp: { transport: "http", url: "https://api.example.invalid/mcp" },
      }),
    );

    // 1. opencode.jsonc sibling fails closed and does NOT create opencode.json
    const ocJsonc = join(home, ".config", "opencode", "opencode.jsonc");
    writeFileSync(ocJsonc, '// my comment\n{\n  "mcp": {}\n}\n');
    const rOcJsonc = runCmd([SYNC_BIN, "--targets", "opencode"], env);
    expect(rOcJsonc.exitCode).toBe(1);
    expect(rOcJsonc.stderr).toContain("JSONC");
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    rmSync(ocJsonc);

    // 2. cursor mcp.jsonc sibling also fails closed
    const curJsonc = join(home, ".cursor", "mcp.jsonc");
    writeFileSync(curJsonc, '/* block comment */\n{}\n');
    const rCurJsonc = runCmd([SYNC_BIN, "--targets", "cursor"], env);
    expect(rCurJsonc.exitCode).toBe(1);
    expect(rCurJsonc.stderr).toContain("JSONC");
    rmSync(curJsonc);

    // 3. Commented JSON / trailing comma fails closed on Claude & Antigravity with JSONC note
    writeFileSync(join(home, ".claude.json"), '// comment\n{"userId":"u1"}\n');
    const rClaudeComment = runCmd([SYNC_BIN, "--targets", "claude"], env);
    expect(rClaudeComment.exitCode).toBe(1);
    expect(rClaudeComment.stderr).toContain("JSONC");

    writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), '{"mcpServers": {},}\n');
    const rAgTrailing = runCmd([SYNC_BIN, "--targets", "antigravity"], env);
    expect(rAgTrailing.exitCode).toBe(1);
    expect(rAgTrailing.stderr).toContain("JSONC");

    // 4. Corrupt OpenCode `mcp: null` fails closed
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: null }));
    const rOcNull = runCmd([SYNC_BIN, "--targets", "opencode"], env);
    expect(rOcNull.exitCode).toBe(1);
    expect(rOcNull.stderr).toContain('"mcp" must be a JSON object (found null)');
    rmSync(join(home, ".config", "opencode", "opencode.json"));

    // 5. Valid JSON containing https:// URLs (contains `//`) succeeds cleanly across all 4 JSON adapters!
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ userId: "u1", docsUrl: "https://docs.example.invalid/guide" }, null, 2) + "\n",
    );
    writeFileSync(
      join(home, ".gemini", "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: {} }, null, 2) + "\n",
    );
    const rValid = runCmd([SYNC_BIN, "--targets", "claude,antigravity,cursor,opencode"], env);
    expect(rValid.exitCode).toBe(0);
    expect(runCmd([SYNC_BIN, "--targets", "claude,antigravity,cursor,opencode", "--check"], env).exitCode).toBe(0);
  });

  test("backward-compatible loading of existing 3-agent v2 ledger causes zero churn", () => {
    const { home, hub, env } = makeSandbox();
    // Remove cursor & opencode dirs to mirror a 3-agent machine
    rmSync(join(home, ".cursor"), { recursive: true, force: true });
    rmSync(join(home, ".config", "opencode"), { recursive: true, force: true });

    mkdirSync(join(hub, "mcp", "alpha"), { recursive: true });
    writeFileSync(join(hub, "mcp", "alpha", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/alpha" } }));
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);

    // Strip cursor & opencode keys from state-*.json to simulate a pre-Phase-1 3-agent ledger
    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    const cur = JSON.parse(readFileSync(paths.statePath, "utf8"));
    delete cur.mcp.cursor;
    delete cur.mcp.opencode;
    delete cur.resolvedLegacyV1.cursor;
    delete cur.resolvedLegacyV1.opencode;
    const legacy3AgentRaw = JSON.stringify(cur, null, 2) + "\n";
    writeFileSync(paths.statePath, legacy3AgentRaw);

    // --check passes (exit 0) AND ordinary sync causes ZERO state churn!
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    expect(readFileSync(paths.statePath, "utf8")).toBe(legacy3AgentRaw);
  });
});
