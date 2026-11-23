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
import { decodeOutput, isSyncAgents } from "./jsonl.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
// AGENT_HUB_BINARY runs this suite against a compiled binary instead of the source wrapper.
const SYNC_BIN = process.env.AGENT_HUB_BINARY || join(REPO_ROOT, "bin", "sync-agents");
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
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  // sync-agents speaks JSON Lines; validate every line, then assert against the human messages.
  if (isSyncAgents(cmd) && !cmd.includes("--human")) {
    return { exitCode: proc.exitCode, ...decodeOutput(stdout, stderr) };
  }
  return { exitCode: proc.exitCode, stdout, stderr, events: [] };
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
    // OpenCode's current layout: mcp.servers, no `enabled` flag (flyingrobots/agent-hub#13).
    expect(ocCfg.mcp.servers["local-srv"]).toEqual({
      type: "local",
      command: ["/usr/bin/local-srv", "--flag"],
      environment: { BASE: "1", OC: "yes" },
    });
    expect(ocCfg.mcp.servers["sse-srv"]).toEqual({
      type: "remote",
      url: "https://example.invalid/sse",
      headers: { "X-Client": "agent-hub" },
    });
    expect(statSync(ocPath).mode & 0o777).toBe(0o600);

    // --check passes cleanly
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);

    // Removing canonical servers prunes cleanly from Cursor and OpenCode
    rmSync(join(hub, "mcp", "local-srv"), { recursive: true, force: true });
    rmSync(join(hub, "mcp", "sse-srv"), { recursive: true, force: true });
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers).toEqual({});
    expect(JSON.parse(readFileSync(ocPath, "utf8")).mcp).toEqual({ servers: {} });
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

    // lstat, not existsSync: the skill source was deleted, so a surviving link would dangle.
    expect(() => lstatSync(join(home, ".claude", "skills", "demo-skill"))).toThrow();
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
    expect(rOcNull.stderr).toContain('"disabledTargets": ["opencode:mcp"]');
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

describe("Phase 1 review fixes (CodeRabbit PR #2)", () => {
  function writeSseServer(hub: string) {
    mkdirSync(join(hub, "mcp", "sse-only"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "sse-only", "mcp.json"),
      JSON.stringify({ mcp: { transport: "sse", url: "https://example.invalid/sse" } }),
    );
  }

  test("SSE server without per-agent overrides syncs when SSE-incapable adapters are excluded by --targets or disabledTargets", () => {
    const { home, hub, env } = makeSandbox();
    writeSseServer(hub);
    const cursorPath = join(home, ".cursor", "mcp.json");

    const rTargets = runCmd([SYNC_BIN, "--targets", "cursor"], env);
    expect(rTargets.stderr).toBe("");
    expect(rTargets.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers["sse-only"].url).toBe(
      "https://example.invalid/sse",
    );

    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agent-hub", "config.json"),
      JSON.stringify({ disabledTargets: ["codex", "antigravity"] }),
    );
    const rDisabled = runCmd([SYNC_BIN], env);
    expect(rDisabled.stderr).toBe("");
    expect(rDisabled.exitCode).toBe(0);
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);

    // An active SSE-incapable adapter still rejects the transport.
    const rCodex = runCmd([SYNC_BIN, "--targets", "codex"], env);
    expect(rCodex.exitCode).toBe(1);
    expect(rCodex.stderr).toContain("sse");
  });

  test("JSONC guard fails closed when both <name>.json and <name>.jsonc exist, leaving the .json untouched", () => {
    const { home, hub, env } = makeSandbox();
    mkdirSync(join(hub, "mcp", "remote-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "remote-srv", "mcp.json"),
      JSON.stringify({ mcp: { transport: "http", url: "https://api.example.invalid/mcp" } }),
    );
    const cases: Array<[string, string]> = [
      ["opencode", join(home, ".config", "opencode", "opencode.json")],
      ["cursor", join(home, ".cursor", "mcp.json")],
      ["claude", join(home, ".claude.json")],
      ["antigravity", join(home, ".gemini", "config", "mcp_config.json")],
    ];
    for (const [target, jsonPath] of cases) {
      const original = JSON.stringify({ keep: true }, null, 2) + "\n";
      writeFileSync(jsonPath, original);
      writeFileSync(`${jsonPath}c`, "// comment\n{}\n");
      const r = runCmd([SYNC_BIN, "--targets", target], env);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("JSONC");
      expect(readFileSync(jsonPath, "utf8")).toBe(original);
      rmSync(`${jsonPath}c`);
    }
  });

  test("restricted --targets sync never prunes link records whose owning target cannot be resolved", () => {
    const { home, hub, env } = makeSandbox();
    mkdirSync(join(hub, "skills", "demo"), { recursive: true });
    writeFileSync(join(hub, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agent-hub", "config.json"),
      JSON.stringify({ agentsDir: hub }),
    );
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    const cursorLink = join(home, ".cursor", "skills", "demo");
    expect(lstatSync(cursorLink).isSymbolicLink()).toBe(true);

    // Same hub + same state/config dirs, but a different HOME: old destinations no longer
    // resolve to any target root under the new HOME.
    const otherHome = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-p1-other-")));
    tempRoots.push(otherHome);
    mkdirSync(join(otherHome, ".claude", "skills"), { recursive: true });
    const r = runCmd([SYNC_BIN, "--targets", "claude"], { ...env, HOME: otherHome });
    expect(r.exitCode).toBe(0);
    expect(lstatSync(cursorLink).isSymbolicLink()).toBe(true);
    const { statePath } = getStatePaths(hub, home, env.XDG_STATE_HOME);
    expect(loadOwnershipState(statePath, hub).state.links[cursorLink]).toBeDefined();
  });
});

describe("Baker Street round 1 repairs (PR #2)", () => {
  function writeHttpServer(hub: string) {
    mkdirSync(join(hub, "mcp", "remote-srv"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "remote-srv", "mcp.json"),
      JSON.stringify({
        mcp: { transport: "http", url: "https://api.example.invalid/mcp", headers: { "X-K": "v" } },
      }),
    );
  }

  test("R-4a: invalid disabledTargets (unknown name, non-array) fails closed without mutating any target", () => {
    const { home, hub, env } = makeSandbox();
    writeHttpServer(hub);
    const cfgDir = join(home, ".config", "agent-hub");
    mkdirSync(cfgDir, { recursive: true });
    const claudeBefore = readFileSync(join(home, ".claude.json"), "utf8");
    for (const [value, needle] of [
      [["gemini"], 'unknown target "gemini" in disabledTargets'],
      ["cursor", '"disabledTargets" must be an array'],
    ] as const) {
      writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ disabledTargets: value }));
      const r = runCmd([SYNC_BIN], env);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(needle);
      expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(claudeBefore);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
      expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    }
  });

  test("R-4b: Cursor and OpenCode compile http servers to the documented shapes", () => {
    const { home, hub, env } = makeSandbox();
    writeHttpServer(hub);
    expect(runCmd([SYNC_BIN, "--targets", "cursor,opencode"], env).exitCode).toBe(0);
    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers["remote-srv"]).toEqual({
      url: "https://api.example.invalid/mcp",
      headers: { "X-K": "v" },
    });
    const oc = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
    expect(oc.mcp.servers["remote-srv"]).toEqual({
      type: "remote",
      url: "https://api.example.invalid/mcp",
      headers: { "X-K": "v" },
    });
  });

  test("R-4c: --dry-run and --explain honor --targets and change nothing", () => {
    const { home, hub, env } = makeSandbox();
    writeHttpServer(hub);
    for (const args of [["--dry-run", "--targets", "claude"], ["--explain", "--targets=claude"]]) {
      const r = runCmd([SYNC_BIN, ...args], env);
      expect(r.exitCode).toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toContain(".claude.json#remote-srv");
      expect(out).not.toContain(".cursor");
      expect(out).not.toContain("opencode");
      expect(out).not.toContain(".codex");
      expect(out).not.toContain(".gemini");
    }
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers).toBeUndefined();
  });

  test("R-2: a JSONC refusal names its scope and the --targets/disabledTargets opt-out", () => {
    const { home, hub, env } = makeSandbox();
    writeHttpServer(hub);
    writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "// c\n{}\n");
    const r = runCmd([SYNC_BIN], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("JSONC");
    expect(r.stderr).toContain("--targets");
    expect(r.stderr).toContain('"disabledTargets": ["opencode:mcp"]');
    expect(r.stderr).toContain(join(home, ".config", "agent-hub", "config.json"));
    expect(r.stderr).toContain("no Phase 2 target or ledger changes were applied");
    // The run as a whole is refused: Claude did not receive the server either.
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers).toBeUndefined();

    // A commented .json gets the same remedy text, naming its own target.
    rmSync(join(home, ".config", "opencode", "opencode.jsonc"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "// c\n{}\n");
    const r2 = runCmd([SYNC_BIN], env);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain('"disabledTargets": ["cursor:mcp"]');
  });

  test("R-2: a conflict with a personal entry in one target names the opt-out, not only --force", () => {
    const { home, hub, env } = makeSandbox();
    writeHttpServer(hub);
    const cursorPath = join(home, ".cursor", "mcp.json");
    const mine = JSON.stringify({ mcpServers: { "remote-srv": { command: "/bin/mine" } } }, null, 2) + "\n";
    writeFileSync(cursorPath, mine);
    const r = runCmd([SYNC_BIN], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[conflict]");
    expect(r.stderr).toContain('"disabledTargets": ["cursor:mcp"]');
    expect(readFileSync(cursorPath, "utf8")).toBe(mine);
  });

  test("R-5: duplicate object keys in any JSON target fail closed and leave the file untouched", () => {
    const { home, hub, env } = makeSandbox();
    writeHttpServer(hub);
    const cases: Array<[string, string, string]> = [
      ["claude", join(home, ".claude.json"), "mcpServers"],
      ["antigravity", join(home, ".gemini", "config", "mcp_config.json"), "mcpServers"],
      ["cursor", join(home, ".cursor", "mcp.json"), "mcpServers"],
      ["opencode", join(home, ".config", "opencode", "opencode.json"), "mcp"],
    ];
    for (const [target, path, root] of cases) {
      const text = `{"${root}": {"mine": {"command": "/bin/mine"}}, "x": "https://a.invalid//b", "${root}": {}}\n`;
      writeFileSync(path, text);
      const r = runCmd([SYNC_BIN, "--targets", target], env);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`duplicate key "${root}"`);
      expect(readFileSync(path, "utf8")).toBe(text);
      rmSync(path);
    }
    // Nested duplicates, including escape-equivalent spellings, are refused too.
    const nested = '{"mcpServers": {"a": {"command": "/x", "comm\\u0061nd": "/y"}}}\n';
    writeFileSync(join(home, ".cursor", "mcp.json"), nested);
    const rn = runCmd([SYNC_BIN, "--targets", "cursor"], env);
    expect(rn.exitCode).toBe(1);
    expect(rn.stderr).toContain('duplicate key "command"');
  });
});

describe("Domain-scoped targets (<target>:mcp, <target>:links)", () => {
  function writeSkillAndServer(hub: string) {
    mkdirSync(join(hub, "skills", "demo"), { recursive: true });
    writeFileSync(join(hub, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
    mkdirSync(join(hub, "mcp", "srv"), { recursive: true });
    writeFileSync(join(hub, "mcp", "srv", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/srv" } }));
  }

  test("disabledTargets [\"opencode:mcp\"] keeps OpenCode links syncing past an opencode.jsonc", () => {
    const { home, hub, env } = makeSandbox();
    writeSkillAndServer(hub);
    const jsonc = join(home, ".config", "opencode", "opencode.jsonc");
    writeFileSync(jsonc, "// mine\n{}\n");
    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agent-hub", "config.json"),
      JSON.stringify({ disabledTargets: ["opencode:mcp"] }),
    );
    const r = runCmd([SYNC_BIN], env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(lstatSync(join(home, ".config", "opencode", "skills", "demo")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, ".config", "opencode", "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(jsonc, "utf8")).toBe("// mine\n{}\n");
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.srv).toBeDefined();
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
  });

  test("--targets mixes whole targets and single domains", () => {
    const { home, hub, env } = makeSandbox();
    writeSkillAndServer(hub);
    const r = runCmd([SYNC_BIN, "--targets", "claude,opencode:links,cursor:mcp"], env);
    expect(r.exitCode).toBe(0);
    expect(lstatSync(join(home, ".claude", "skills", "demo")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.srv).toBeDefined();
    expect(lstatSync(join(home, ".config", "opencode", "skills", "demo")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.srv).toBeDefined();
    expect(existsSync(join(home, ".cursor", "skills", "demo"))).toBe(false);
    expect(existsSync(join(home, ".codex", "skills", "demo"))).toBe(false);
  });

  test("unknown domain is rejected: exit 2 from --targets, exit 1 from config", () => {
    const { home, env } = makeSandbox();
    const r = runCmd([SYNC_BIN, "--targets", "opencode:rules"], env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('unknown target "opencode:rules"');
    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agent-hub", "config.json"),
      JSON.stringify({ disabledTargets: ["cursor:skills"] }),
    );
    const r2 = runCmd([SYNC_BIN], env);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain('unknown target "cursor:skills"');
  });
});

describe("Link ownership is never inferred from an overlapping HOME (CodeRabbit PR #2, links.ts:557)", () => {
  test("a Claude link recorded under an old HOME nested in ~/.cursor survives a --targets cursor run", () => {
    const { home, hub, env } = makeSandbox();
    mkdirSync(join(hub, "skills", "demo"), { recursive: true });
    writeFileSync(join(hub, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
    // Old HOME is <home>/.cursor, with its own ~/.claude/skills.
    const oldHome = join(home, ".cursor");
    mkdirSync(join(oldHome, ".claude", "skills"), { recursive: true });
    const r1 = runCmd([SYNC_BIN, "--dir", hub, "--targets", "claude:links"], { ...env, HOME: oldHome });
    expect(r1.exitCode).toBe(0);
    const oldClaudeLink = join(oldHome, ".claude", "skills", "demo");
    expect(lstatSync(oldClaudeLink).isSymbolicLink()).toBe(true);

    // New HOME is <home>; same hub and state dir; only Cursor selected.
    const r2 = runCmd([SYNC_BIN, "--dir", hub, "--targets", "cursor"], env);
    expect(r2.exitCode).toBe(0);
    expect(lstatSync(oldClaudeLink).isSymbolicLink()).toBe(true);
    const { statePath } = getStatePaths(hub, home, env.XDG_STATE_HOME);
    expect(loadOwnershipState(statePath, hub).state.links[oldClaudeLink]).toBeDefined();
  });
});

describe("Every whole-run MCP refusal names the opt-out", () => {
  test("non-object JSON root, invalid TOML, and a non-table mcp_servers all carry the remedy", () => {
    const { home, env } = makeSandbox();
    writeFileSync(join(home, ".cursor", "mcp.json"), "[]\n");
    const r1 = runCmd([SYNC_BIN, "--targets", "cursor"], env);
    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).toContain("must contain a JSON object");
    expect(r1.stderr).toContain('"disabledTargets": ["cursor:mcp"]');

    const toml = join(home, ".codex", "config.toml");
    writeFileSync(toml, "model = \n");
    const r2 = runCmd([SYNC_BIN, "--targets", "codex"], env);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain("invalid TOML");
    expect(r2.stderr).toContain('"disabledTargets": ["codex:mcp"]');

    writeFileSync(toml, 'mcp_servers = "x"\n');
    const r3 = runCmd([SYNC_BIN, "--targets", "codex"], env);
    expect(r3.exitCode).toBe(1);
    expect(r3.stderr).toContain('"disabledTargets": ["codex:mcp"]');
    expect(readFileSync(toml, "utf8")).toBe('mcp_servers = "x"\n');
  });
});

describe("Scoped runs still prune the active target's own stale links", () => {
  test("--targets cursor:links prunes a removed skill from Cursor and keeps Claude's", () => {
    const { home, hub, env } = makeSandbox();
    for (const n of ["keep", "gone"]) {
      mkdirSync(join(hub, "skills", n), { recursive: true });
      writeFileSync(join(hub, "skills", n, "SKILL.md"), `---\nname: ${n}\ndescription: d\n---\n`);
    }
    expect(runCmd([SYNC_BIN], env).exitCode).toBe(0);
    rmSync(join(hub, "skills", "gone"), { recursive: true });
    const r = runCmd([SYNC_BIN, "--targets", "cursor:links"], env);
    expect(r.exitCode).toBe(0);
    // lstat, not existsSync: a dangling link must count as present.
    expect(() => lstatSync(join(home, ".cursor", "skills", "gone"))).toThrow();
    expect(lstatSync(join(home, ".cursor", "skills", "keep")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, ".claude", "skills", "gone")).isSymbolicLink()).toBe(true);
    expect(runCmd([SYNC_BIN, "--check", "--targets", "cursor:links"], env).exitCode).toBe(0);
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(1);
  });
});
