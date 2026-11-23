import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/cli.ts";
import { getStatePaths, loadOwnershipState } from "../src/state.ts";
import { parseTargetSelector, type SyncOptions } from "../src/types.ts";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

// A real HOME plus an alias symlink to it; the hub and state live outside both spellings.
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-rekey-")));
  tempRoots.push(root);
  const home = join(root, "home");
  const alias = join(root, "alias");
  const hub = join(root, "hub");
  mkdirSync(join(hub, "skills", "demo"), { recursive: true });
  writeFileSync(join(hub, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
  writeFileSync(join(hub, "AGENTS.md"), "# rules\n");
  mkdirSync(join(hub, "mcp", "alpha"), { recursive: true });
  writeFileSync(join(hub, "mcp", "alpha", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/alpha" } }));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  symlinkSync(home, alias);
  const opts = (h: string, targets?: string[]): SyncOptions => ({
    hubDir: hub,
    homeDir: h,
    xdgConfigHome: join(h, ".config"),
    xdgStateHome: join(root, "state"),
    ...(targets ? { targets: targets.map((t) => parseTargetSelector(t)!) } : { targets: ["claude", "cursor"].map((t) => parseTargetSelector(t)!) }),
  });
  const ledger = () => loadOwnershipState(getStatePaths(hub, home, join(root, "state")).statePath, hub).state;
  return { root, home, alias, hub, opts, ledger };
}
const out = (r: { stdout: string[]; stderr: string[] }) => [...r.stdout, ...r.stderr].join("\n");

describe("ownership records follow the spelling of the last run (flyingrobots/agent-hub#20)", () => {
  test("after a run under a new spelling, link and MCP records carry it; removing the old alias then causes no conflict", () => {
    const { home, alias, opts, ledger } = sandbox();
    expect(runSync(opts(alias)).exitCode).toBe(0);
    expect(Object.keys(ledger().links).every((k) => k.startsWith(alias))).toBe(true);
    expect(ledger().mcp.claude.alpha!.configPath.startsWith(alias)).toBe(true);

    const r = runSync(opts(home));
    expect(out(r)).not.toContain("conflict");
    expect(r.exitCode).toBe(0);
    const links = Object.keys(ledger().links);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((k) => k.startsWith(home))).toBe(true);
    expect(ledger().mcp.claude.alpha!.configPath).toBe(join(home, ".claude.json"));
    expect(ledger().mcp.cursor.alpha!.configPath).toBe(join(home, ".cursor", "mcp.json"));

    unlinkSync(alias);
    const chk = runSync({ ...opts(home), checkOnly: true });
    expect(out(chk)).not.toContain("conflict");
    expect(out(chk)).not.toContain("moved");
    expect(chk.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.alpha).toBeDefined();
  });

  test("a re-key is ledger-only: no target file changes", () => {
    const { home, alias, opts } = sandbox();
    expect(runSync(opts(alias)).exitCode).toBe(0);
    const before = readFileSync(join(home, ".claude.json"), "utf8");
    const r = runSync(opts(home));
    expect(r.exitCode).toBe(0);
    expect(out(r)).toMatch(/rekey-(link|mcp)-record/);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
    // Once re-keyed, the next run under the same spelling has nothing to do.
    const again = runSync(opts(home));
    expect(again.exitCode).toBe(0);
    expect(out(again)).not.toMatch(/rekey-(link|mcp)-record/);
    expect(out(again)).toContain("everything is in sync");
  });

  test("a scoped run re-keys only the active targets' records", () => {
    const { home, alias, opts, ledger } = sandbox();
    expect(runSync(opts(alias)).exitCode).toBe(0);
    expect(runSync(opts(home, ["claude"])).exitCode).toBe(0);
    const links = Object.keys(ledger().links);
    expect(links.filter((k) => k.includes("/.claude/")).every((k) => k.startsWith(home))).toBe(true);
    expect(links.filter((k) => k.includes("/.cursor/")).every((k) => k.startsWith(alias))).toBe(true);
    expect(ledger().mcp.claude.alpha!.configPath.startsWith(home)).toBe(true);
    expect(ledger().mcp.cursor.alpha!.configPath.startsWith(alias)).toBe(true);
  });

  // ~/.codex/skills is a symlink to ~/.claude/skills: two desired links, one physical path.
  function sharedSkills() {
    const sb = sandbox();
    mkdirSync(join(sb.home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    symlinkSync(join(sb.home, ".claude", "skills"), join(sb.home, ".codex", "skills"));
    const both = sb.opts(sb.home, ["claude:links", "codex:links"]);
    return { ...sb, both };
  }

  test("two desired links with one physical path: the first run succeeds and later runs neither re-key nor churn", () => {
    const { both, ledger } = sharedSkills();
    expect(runSync(both).exitCode).toBe(0);
    const keys = Object.keys(ledger().links).sort();
    for (let i = 0; i < 3; i++) {
      const r = runSync(both);
      expect(r.exitCode).toBe(0);
      expect(out(r)).not.toMatch(/rekey-(link|mcp)-record/);
      expect(out(r)).toContain("everything is in sync");
      expect(Object.keys(ledger().links).sort()).toEqual(keys);
    }
  });

  test("after the shared directory is split, the link agent-hub made is still its own (no unmanaged conflict)", () => {
    const { home, both } = sharedSkills();
    for (let i = 0; i < 4; i++) expect(runSync(both).exitCode).toBe(0);
    unlinkSync(join(home, ".codex", "skills"));
    mkdirSync(join(home, ".codex", "skills"));
    const r = runSync(both);
    expect(out(r)).not.toContain("conflict");
    expect(r.exitCode).toBe(0);
    expect(lstatSync(join(home, ".codex", "skills", "demo")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, ".claude", "skills", "demo")).isSymbolicLink()).toBe(true);
  });

  test("a scoped run never moves another target's record into its own spelling", () => {
    const { home, opts, ledger } = sharedSkills();
    expect(runSync(opts(home, ["claude:links"])).exitCode).toBe(0);
    const claudeSkill = join(home, ".claude", "skills", "demo");
    expect(ledger().links[claudeSkill]).toBeDefined();
    const r = runSync(opts(home, ["codex:links"]));
    expect(r.exitCode).toBe(0);
    expect(out(r)).not.toMatch(/rekey-(link|mcp)-record/);
    // codex gets its own rules link; the shared skill keeps claude's record.
    expect(ledger().links[claudeSkill]).toBeDefined();
    expect(ledger().links[join(home, ".codex", "skills", "demo")]).toBeUndefined();
  });

  test("--check prints no re-key lines; a record pruned in the same run is not reported as re-keyed", () => {
    const { home, alias, hub, opts } = sandbox();
    mkdirSync(join(hub, "mcp", "beta"), { recursive: true });
    writeFileSync(join(hub, "mcp", "beta", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/beta" } }));
    expect(runSync(opts(alias)).exitCode).toBe(0);
    const chk = runSync({ ...opts(home), checkOnly: true });
    expect(chk.exitCode).toBe(0);
    expect(out(chk)).not.toMatch(/rekey-(link|mcp)-record/);
    rmSync(join(hub, "mcp", "beta"), { recursive: true });
    const r = runSync(opts(home));
    expect(r.exitCode).toBe(0);
    expect(out(r)).not.toMatch(/rekey-mcp-record[^\n]*#beta/);
    expect(out(r)).toMatch(/mcp-prune[^\n]*beta/);
  });
});
