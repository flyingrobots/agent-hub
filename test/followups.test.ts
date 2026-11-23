import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { runSync } from "../src/cli.ts";
import { loadCanonicalServers } from "../src/mcp.ts";
import { getStatePaths, loadOwnershipState } from "../src/state.ts";
import { parseTargetSelector, type SyncOptions, type TargetSelector } from "../src/types.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_BIN = join(REPO_ROOT, "bin", "sync-agents");
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function sandbox(opts: { cursor?: boolean; opencode?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-fu-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  for (const d of [
    join(hub, "skills"),
    join(hub, "mcp"),
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".gemini", "config"),
    join(home, ".gemini", "skills"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  if (opts.cursor) mkdirSync(join(home, ".cursor", "skills"), { recursive: true });
  if (opts.opencode) mkdirSync(join(home, ".config", "opencode", "skills"), { recursive: true });
  writeFileSync(join(hub, "AGENTS.md"), "# Rules\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ userId: "u1" }, null, 2) + "\n");
  chmodSync(join(home, ".claude.json"), 0o600);
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  chmodSync(join(home, ".codex", "config.toml"), 0o600);
  const base: SyncOptions = {
    hubDir: hub,
    homeDir: home,
    xdgConfigHome: join(home, ".config"),
    xdgStateHome: join(home, ".local", "state"),
  };
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  return { home, hub, base, env };
}

function server(hub: string, name: string, spec: Record<string, unknown>) {
  mkdirSync(join(hub, "mcp", name), { recursive: true });
  writeFileSync(join(hub, "mcp", name, "mcp.json"), JSON.stringify({ mcp: spec }));
}

function skill(hub: string, name: string) {
  mkdirSync(join(hub, "skills", name), { recursive: true });
  writeFileSync(join(hub, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
}

const sel = (...names: string[]): TargetSelector[] => names.map((n) => parseTargetSelector(n)!);
const out = (r: { stdout: string[]; stderr: string[] }) => [...r.stdout, ...r.stderr].join("\n");
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

function runCli(args: string[], env: Record<string, string>) {
  const p = Bun.spawnSync([SYNC_BIN, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("Phase 1 follow-ups (flyingrobots/agent-hub#3)", () => {
  test("zero churn for a three-target ledger when ~/.cursor and ~/.config/opencode already exist", () => {
    const { home, hub, base } = sandbox({ cursor: true, opencode: true });
    skill(hub, "demo");
    server(hub, "alpha", { command: "/bin/alpha" });
    const legacy = sel("antigravity", "claude", "codex");
    expect(runSync({ ...base, targets: legacy }).exitCode).toBe(0);
    const { statePath } = getStatePaths(hub, home, base.xdgStateHome);
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    delete raw.mcp.cursor;
    delete raw.mcp.opencode;
    if (raw.resolvedLegacyV1) {
      delete raw.resolvedLegacyV1.cursor;
      delete raw.resolvedLegacyV1.opencode;
    }
    writeFileSync(statePath, JSON.stringify(raw, null, 2) + "\n");
    const before = readFileSync(statePath, "utf8");
    expect(runSync({ ...base, targets: legacy, checkOnly: true }).exitCode).toBe(0);
    expect(runSync({ ...base, targets: legacy }).exitCode).toBe(0);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  test("OpenCode links and MCP follow $XDG_CONFIG_HOME, as OpenCode itself does", () => {
    const { home, hub, base } = sandbox();
    skill(hub, "demo");
    server(hub, "alpha", { command: "/bin/alpha" });
    const xdg = join(home, "xdg-config");
    mkdirSync(join(xdg, "opencode", "skills"), { recursive: true });
    const r = runSync({ ...base, xdgConfigHome: xdg, targets: sel("opencode") });
    expect(out(r)).not.toContain("error");
    expect(r.exitCode).toBe(0);
    expect(isLink(join(xdg, "opencode", "skills", "demo"))).toBe(true);
    expect(isLink(join(xdg, "opencode", "AGENTS.md"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(xdg, "opencode", "opencode.json"), "utf8"));
    expect(cfg.mcp.alpha.command).toEqual(["/bin/alpha"]);
    expect(runSync({ ...base, xdgConfigHome: xdg, targets: sel("opencode"), checkOnly: true }).exitCode).toBe(0);
  });

  test("bin/sync-agents --print-dir and src/cli.ts --print-dir agree when disabledTargets is invalid", () => {
    const { home, env } = sandbox();
    const alt = join(home, "alt-hub");
    mkdirSync(alt, { recursive: true });
    mkdirSync(join(home, ".config", "agent-hub"), { recursive: true });
    writeFileSync(
      join(home, ".config", "agent-hub", "config.json"),
      JSON.stringify({ agentsDir: alt, disabledTargets: ["bogus"] }),
    );
    const viaWrapper = runCli(["--print-dir"], env).stdout.trim();
    const viaTs = Bun.spawnSync(["bun", join(REPO_ROOT, "src", "cli.ts"), "--print-dir"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      stdout: "pipe",
    }).stdout.toString().trim();
    expect(viaWrapper).toBe(alt);
    expect(viaTs).toBe(viaWrapper);
  });

  test("--disown-legacy naming an agent whose MCP domain is out of scope is refused, not silently dropped", () => {
    const { home, hub, base } = sandbox({ cursor: true });
    writeFileSync(
      join(hub, ".mcp-managed.json"),
      JSON.stringify({ version: 1, managed: { claude: ["legacyx"], codex: [], gemini: [] } }),
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { legacyx: { type: "stdio", command: "/x", args: [] } } }, null, 2) + "\n",
    );
    const r = runSync({ ...base, targets: sel("cursor"), disownLegacy: [{ agent: "claude", name: "legacyx" }] });
    expect(r.exitCode).toBe(2);
    expect(out(r)).toContain("--disown-legacy claude:legacyx");
    expect(out(r)).toContain("--targets");
  });

  test("a repeated --targets flag is a usage error (exit 2), not silently last-wins", () => {
    const { env } = sandbox();
    const r = runCli(["--targets", "claude", "--targets", "codex", "--dry-run"], env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--targets");
  });

  test("the compiled server map has no entry for an inactive agent", () => {
    const { hub } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const map = loadCanonicalServers(hub, new Set(["claude"] as const));
    const perAgent = map.get("alpha")!;
    expect(Object.keys(perAgent)).toEqual(["claude"]);
  });

  test("a Codex editor refusal (dotted mcp_servers key) names the codex:mcp remedy and the config path", () => {
    const { home, hub, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    writeFileSync(join(home, ".codex", "config.toml"), 'mcp_servers.other.command = "/bin/o"\n');
    const r = runSync({ ...base, targets: sel("codex") });
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain('"disabledTargets": ["codex:mcp"]');
    expect(out(r)).toContain(join(home, ".config", "agent-hub", "config.json"));
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(
      'mcp_servers.other.command = "/bin/o"\n',
    );
  });
});

describe("Contract ledger gaps from docs/ (flyingrobots/agent-hub#3)", () => {
  test("SYNC-SCOPE-9: re-enabling an excluded target catches up the prunes it missed", () => {
    const { home, hub, base } = sandbox({ cursor: true });
    skill(hub, "gone");
    server(hub, "gone", { command: "/bin/gone" });
    expect(runSync(base).exitCode).toBe(0);
    rmSync(join(hub, "skills", "gone"), { recursive: true });
    rmSync(join(hub, "mcp", "gone"), { recursive: true });
    expect(runSync({ ...base, targets: sel("claude", "codex", "antigravity") }).exitCode).toBe(0);
    expect(isLink(join(home, ".cursor", "skills", "gone"))).toBe(true);
    expect(runSync(base).exitCode).toBe(0);
    expect(isLink(join(home, ".cursor", "skills", "gone"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.gone).toBeUndefined();
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });

  test("MCP-CMP-5: Codex and Antigravity prune removed servers; new configs get 0600 and Antigravity 0644", () => {
    const { home, hub, base } = sandbox({ cursor: true, opencode: true });
    server(hub, "alpha", { command: "/bin/alpha" });
    expect(runSync(base).exitCode).toBe(0);
    const ag = join(home, ".gemini", "config", "mcp_config.json");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.alpha]");
    expect(JSON.parse(readFileSync(ag, "utf8")).mcpServers.alpha).toBeDefined();
    expect(statSync(ag).mode & 0o777).toBe(0o644);
    expect(statSync(join(home, ".cursor", "mcp.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config", "opencode", "opencode.json")).mode & 0o777).toBe(0o600);
    rmSync(join(hub, "mcp", "alpha"), { recursive: true });
    expect(runSync(base).exitCode).toBe(0);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain("alpha");
    expect(JSON.parse(readFileSync(ag, "utf8")).mcpServers.alpha).toBeUndefined();
  });

  test("OWN-LED-5: a mixed conflict leaves the ledger byte-identical", () => {
    const { home, hub, base } = sandbox();
    server(hub, "ok", { command: "/bin/ok" });
    expect(runSync(base).exitCode).toBe(0);
    const { statePath } = getStatePaths(hub, home, base.xdgStateHome);
    const before = readFileSync(statePath, "utf8");
    server(hub, "new", { command: "/bin/new" });
    server(hub, "clash", { command: "/bin/canon" });
    const cfg = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    cfg.mcpServers.clash = { type: "stdio", command: "/bin/mine", args: [] };
    writeFileSync(join(home, ".claude.json"), JSON.stringify(cfg, null, 2) + "\n");
    const r = runSync(base);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  test("OWN-V1-3: --force replaces a differing entry claimed only by a legacy v1 manifest", () => {
    const { home, hub, base } = sandbox();
    writeFileSync(
      join(hub, ".mcp-managed.json"),
      JSON.stringify({ version: 1, managed: { claude: ["diff"], codex: [], gemini: [] } }),
    );
    server(hub, "diff", { command: "/canon/diff" });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { diff: { type: "stdio", command: "/personal/diff", args: [] } } }, null, 2) + "\n",
    );
    expect(runSync({ ...base, targets: sel("claude") }).exitCode).toBe(1);
    const forced = runSync({ ...base, targets: sel("claude"), force: true });
    expect(forced.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.diff.command).toBe("/canon/diff");
    const { statePath } = getStatePaths(hub, home, base.xdgStateHome);
    expect(loadOwnershipState(statePath, hub).state.mcp.claude.diff).toBeDefined();
  });

  test("OWN-REC-11: Phase 0 recovery of an excluded target's journal refuses when that target was edited", () => {
    const { home, hub, base } = sandbox({ cursor: true });
    server(hub, "alpha", { command: "/bin/alpha" });
    const cursorPath = join(home, ".cursor", "mcp.json");
    const crashed = runSync(base, {
      afterTargetMutate(journal) {
        if (journal.destination === cursorPath) throw new Error("simulated crash after cursor write");
      },
    });
    expect(crashed.exitCode).toBe(1);
    const edited = JSON.stringify({ mcpServers: { mine: { command: "/bin/mine" } } }, null, 2) + "\n";
    writeFileSync(cursorPath, edited);
    const r = runSync({ ...base, targets: sel("claude") });
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain("pending recovery ambiguous");
    expect(readFileSync(cursorPath, "utf8")).toBe(edited);
  });
});

describe("Ledger records follow their config file across an OpenCode XDG move (Baker Street PR #18 H-F-1)", () => {
  function moved() {
    const sb = sandbox({ opencode: true });
    server(sb.hub, "alpha", { command: "/bin/alpha" });
    // First sync with the default base: alpha is recorded against ~/.config/opencode/opencode.json.
    expect(runSync({ ...sb.base, targets: sel("opencode") }).exitCode).toBe(0);
    const oldCfg = join(sb.home, ".config", "opencode", "opencode.json");
    const xdg = join(sb.home, "xdg");
    mkdirSync(join(xdg, "opencode", "skills"), { recursive: true });
    const newCfg = join(xdg, "opencode", "opencode.json");
    return { ...sb, oldCfg, xdg, newCfg, moved: { ...sb.base, xdgConfigHome: xdg, targets: sel("opencode") } };
  }

  test("an identical user entry in the new file is not silently adopted by the old record", () => {
    const { oldCfg, newCfg, moved: opts } = moved();
    const mine = JSON.stringify({ mcp: { alpha: { type: "local", command: ["/bin/alpha"], enabled: true } } }, null, 2) + "\n";
    writeFileSync(newCfg, mine);
    const oldBefore = readFileSync(oldCfg, "utf8");
    const r = runSync(opts);
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain("--adopt");
    expect(readFileSync(newCfg, "utf8")).toBe(mine);
    expect(readFileSync(oldCfg, "utf8")).toBe(oldBefore);
    expect(runSync({ ...opts, adopt: true }).exitCode).toBe(0);
  });

  test("removing the hub server never deletes a same-named user entry from the new file", () => {
    const { hub, oldCfg, newCfg, moved: opts } = moved();
    const mine = JSON.stringify({ mcp: { alpha: { type: "local", command: ["/bin/alpha"], enabled: true } } }, null, 2) + "\n";
    writeFileSync(newCfg, mine);
    rmSync(join(hub, "mcp", "alpha"), { recursive: true });
    const oldBefore = readFileSync(oldCfg, "utf8");
    const r = runSync(opts);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(newCfg, "utf8")).toBe(mine);
    expect(readFileSync(oldCfg, "utf8")).toBe(oldBefore);
  });

  test("an absent entry is added to the new file; the old file is left untouched and the stale record is reported", () => {
    const { home, hub, oldCfg, newCfg, moved: opts, base } = moved();
    const oldBefore = readFileSync(oldCfg, "utf8");
    const r = runSync(opts);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(newCfg, "utf8")).mcp.alpha.command).toEqual(["/bin/alpha"]);
    expect(readFileSync(oldCfg, "utf8")).toBe(oldBefore);
    expect(out(r)).toContain(oldCfg);
    const { statePath } = getStatePaths(hub, home, base.xdgStateHome);
    expect(loadOwnershipState(statePath, hub).state.mcp.opencode.alpha?.configPath).toBe(newCfg);
    expect(runSync({ ...opts, checkOnly: true }).exitCode).toBe(0);
  });
});

describe("XDG_CONFIG_HOME aliases (Baker Street PR #18 M-F-3)", () => {
  test("a symlinked XDG_CONFIG_HOME naming ~/.config causes no churn or conflicts after a default-base sync", () => {
    const { home, hub, base } = sandbox({ opencode: true });
    skill(hub, "demo");
    expect(runSync({ ...base, targets: sel("opencode") }).exitCode).toBe(0);
    const alias = join(home, "cfglink");
    Bun.spawnSync(["ln", "-s", join(home, ".config"), alias]);
    const opts = { ...base, xdgConfigHome: alias, targets: sel("opencode") };
    const chk = runSync({ ...opts, checkOnly: true });
    expect(out(chk)).not.toContain("conflict");
    expect(chk.exitCode).toBe(0);
    expect(runSync({ ...opts, adopt: true }).exitCode).toBe(0);
    expect(isLink(join(home, ".config", "opencode", "skills", "demo"))).toBe(true);
    expect(isLink(join(home, ".config", "opencode", "AGENTS.md"))).toBe(true);
  });

  test("a relative XDG_CONFIG_HOME is ignored, as the XDG spec requires", () => {
    const { home, hub, base } = sandbox({ opencode: true });
    skill(hub, "demo");
    const r = runSync({ ...base, xdgConfigHome: "relative/cfg", cwd: home, targets: sel("opencode") });
    expect(r.exitCode).toBe(0);
    expect(isLink(join(home, ".config", "opencode", "skills", "demo"))).toBe(true);
    expect(isLink(join(home, "relative", "cfg", "opencode", "skills", "demo"))).toBe(false);
  });
});

test("--skill-only with --disown-legacy is a usage error, not a silent success (Baker Street PR #18 M-F-4)", () => {
  const { base } = sandbox();
  const r = runSync({ ...base, skillOnly: true, disownLegacy: [{ agent: "claude", name: "x" }] });
  expect(r.exitCode).toBe(2);
  expect(out(r)).toContain("--skill-only cannot be combined with --disown-legacy");
});

describe("Ownership is compared by physical path, not spelling (Baker Street PR #18 blind pass B-F-1)", () => {
  function dotfilesSandbox() {
    // ~/.config is a symlink into a dotfiles directory, as dotfile managers commonly arrange.
    const sb = sandbox();
    const dots = join(sb.home, "dots", "config");
    mkdirSync(join(dots, "opencode", "skills"), { recursive: true });
    Bun.spawnSync(["ln", "-s", dots, join(sb.home, ".config")]);
    skill(sb.hub, "demo");
    server(sb.hub, "alpha", { command: "/bin/alpha" });
    return sb;
  }

  function bothSpellings(home: string, base: SyncOptions, a: string | undefined, b: string | undefined) {
    const opt = (x: string | undefined) => ({ ...base, xdgConfigHome: x, targets: sel("opencode") });
    expect(runSync(opt(a)).exitCode).toBe(0);
    const chk = runSync({ ...opt(b), checkOnly: true });
    expect(out(chk)).not.toContain("conflict");
    expect(chk.exitCode).toBe(0);
    expect(runSync(opt(b)).exitCode).toBe(0);
    expect(isLink(join(home, "dots", "config", "opencode", "skills", "demo"))).toBe(true);
    expect(isLink(join(home, "dots", "config", "opencode", "AGENTS.md"))).toBe(true);
    expect(runSync({ ...opt(a), checkOnly: true }).exitCode).toBe(0);
  }

  test("symlinked ~/.config: XDG unset then $HOME/.config is zero-conflict and keeps every link", () => {
    const { home, base } = dotfilesSandbox();
    bothSpellings(home, base, undefined, join(home, ".config"));
  });

  test("symlinked ~/.config: XDG $HOME/.config then unset is zero-conflict and keeps every link", () => {
    const { home, base } = dotfilesSandbox();
    bothSpellings(home, base, join(home, ".config"), undefined);
  });

  test("a HOME given through a symlinked alias syncs with zero conflicts after a canonical-HOME sync", () => {
    const { home, hub, base } = sandbox({ cursor: true, opencode: true });
    skill(hub, "demo");
    server(hub, "alpha", { command: "/bin/alpha" });
    expect(runSync(base).exitCode).toBe(0);
    const alias = join(realpathSync(tmpdir()), `ah-alias-${Date.now()}`);
    Bun.spawnSync(["ln", "-s", home, alias]);
    tempRoots.push(alias);
    const viaAlias = { ...base, homeDir: alias, xdgConfigHome: join(alias, ".config") };
    const chk = runSync({ ...viaAlias, checkOnly: true });
    expect(out(chk)).not.toContain("conflict");
    expect(chk.exitCode).toBe(0);
    expect(runSync(viaAlias).exitCode).toBe(0);
    expect(isLink(join(home, ".cursor", "skills", "demo"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.alpha).toBeDefined();
  });
});

test("a relative XDG_STATE_HOME is ignored, as the XDG spec requires (Baker Street PR #18 blind pass B-F-3)", () => {
  const { home, hub, base } = sandbox();
  skill(hub, "demo");
  expect(runSync({ ...base, xdgStateHome: "rel/state", cwd: home }).exitCode).toBe(0);
  const { statePath } = getStatePaths(hub, home, undefined);
  expect(statePath.startsWith(join(home, ".local", "state"))).toBe(true);
  expect(loadOwnershipState(statePath, hub).existsOnDisk).toBe(true);
});
