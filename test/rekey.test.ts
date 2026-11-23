import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "./jsonl.ts";
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
    // alpha newly disabled for claude: also removed, so not reported as re-keyed either.
    writeFileSync(join(hub, "mcp", "alpha", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/alpha" }, overrides: { claude: { disabled: true } } }));
    const r = runSync(opts(home));
    expect(r.exitCode).toBe(0);
    expect(out(r)).not.toMatch(/rekey-mcp-record[^\n]*\.claude\.json#(beta|alpha)/);
    expect(out(r)).toMatch(/mcp-prune[^\n]*beta/);
    expect(out(r)).toMatch(/mcp-remove[^\n]*alpha/);
  });

  // ~/.claude/skills is a symlink to ~/.codex/skills: the symlinked spelling sorts first.
  function sharedSkillsReversed() {
    const sb = sandbox();
    mkdirSync(join(sb.home, ".codex", "skills"), { recursive: true });
    symlinkSync(join(sb.home, ".codex", "skills"), join(sb.home, ".claude", "skills"));
    const both = sb.opts(sb.home, ["claude:links", "codex:links"]);
    return { ...sb, both };
  }

  test("the shared link's record lives under the spelling with no symlink in its path, whichever side sorts first", () => {
    const { home, both, ledger } = sharedSkillsReversed();
    expect(runSync(both).exitCode).toBe(0);
    expect(ledger().links[join(home, ".codex", "skills", "demo")]).toBeDefined();
    expect(ledger().links[join(home, ".claude", "skills", "demo")]).toBeUndefined();
  });

  test("splitting the symlinked side leaves both links agent-hub's, in both directions", () => {
    for (const make of [sharedSkills, sharedSkillsReversed]) {
      const { home, both } = make();
      for (let i = 0; i < 2; i++) expect(runSync(both).exitCode).toBe(0);
      const linkedSide = make === sharedSkills ? join(home, ".codex", "skills") : join(home, ".claude", "skills");
      unlinkSync(linkedSide);
      mkdirSync(linkedSide);
      const r = runSync(both);
      expect(out(r)).not.toContain("conflict");
      expect(r.exitCode).toBe(0);
      expect(lstatSync(join(home, ".codex", "skills", "demo")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(home, ".claude", "skills", "demo")).isSymbolicLink()).toBe(true);
    }
  });

  test("a record an earlier run left under the symlinked spelling moves to the physical one", () => {
    const { home, opts, both, ledger } = sharedSkillsReversed();
    // A claude-only run records the link under claude's (symlinked) spelling.
    expect(runSync(opts(home, ["claude:links"])).exitCode).toBe(0);
    expect(ledger().links[join(home, ".claude", "skills", "demo")]).toBeDefined();
    const r = runSync(both);
    expect(r.exitCode).toBe(0);
    expect(ledger().links[join(home, ".codex", "skills", "demo")]).toBeDefined();
    expect(ledger().links[join(home, ".claude", "skills", "demo")]).toBeUndefined();
    unlinkSync(join(home, ".claude", "skills"));
    mkdirSync(join(home, ".claude", "skills"));
    const after = runSync(both);
    expect(out(after)).not.toContain("conflict");
    expect(after.exitCode).toBe(0);
  });

  test("with HOME reached through an alias, the record still lives under the spelling with fewer symlinks", () => {
    const { alias, opts, ledger } = sharedSkillsReversed();
    const both = opts(alias, ["claude:links", "codex:links"]);
    expect(runSync(both).exitCode).toBe(0);
    expect(ledger().links[join(alias, ".codex", "skills", "demo")]).toBeDefined();
    expect(ledger().links[join(alias, ".claude", "skills", "demo")]).toBeUndefined();
    unlinkSync(join(alias, ".claude", "skills"));
    mkdirSync(join(alias, ".claude", "skills"));
    const r = runSync(both);
    expect(out(r)).not.toContain("conflict");
    expect(r.exitCode).toBe(0);
  });

  test("a scoped run never moves another target's record into its own physical spelling", () => {
    const { home, opts, ledger } = sharedSkillsReversed();
    // claude's spelling is the symlinked one; a claude-only run records the link there.
    expect(runSync(opts(home, ["claude:links"])).exitCode).toBe(0);
    const claudeKey = join(home, ".claude", "skills", "demo");
    expect(ledger().links[claudeKey]).toBeDefined();
    const r = runSync(opts(home, ["codex:links"]));
    expect(r.exitCode).toBe(0);
    expect(out(r)).not.toMatch(/rekey-(link|mcp)-record/);
    expect(ledger().links[claudeKey]).toBeDefined();
    expect(ledger().links[join(home, ".codex", "skills", "demo")]).toBeUndefined();
  });
});

describe("shared skills directories: ownership edge cases (flyingrobots/agent-hub#37)", () => {
  // ~/.claude/skills and ~/.codex/skills are both symlinks to a third directory.
  function sharedThird() {
    const sb = sandbox();
    const third = join(sb.root, "shared-skills");
    mkdirSync(third, { recursive: true });
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    symlinkSync(third, join(sb.home, ".claude", "skills"));
    symlinkSync(third, join(sb.home, ".codex", "skills"));
    const both = sb.opts(sb.home, ["claude:links", "codex:links"]);
    return { ...sb, third, both };
  }
  const split = (dir: string) => {
    unlinkSync(dir);
    mkdirSync(dir);
  };
  const statePathOf = (hub: string, home: string, root: string) => getStatePaths(hub, home, join(root, "state")).statePath;

  test("two skills symlinks to a third directory: splitting either side in turn leaves every link owned", () => {
    for (const first of [".claude", ".codex"]) {
      const { home, both } = sharedThird();
      for (let i = 0; i < 2; i++) expect(runSync(both).exitCode).toBe(0);
      const second = first === ".claude" ? ".codex" : ".claude";
      for (const side of [first, second]) {
        split(join(home, side, "skills"));
        const r = runSync(both);
        expect(out(r)).not.toContain("conflict");
        expect(r.exitCode).toBe(0);
        expect(lstatSync(join(home, ".claude", "skills", "demo")).isSymbolicLink()).toBe(true);
        expect(lstatSync(join(home, ".codex", "skills", "demo")).isSymbolicLink()).toBe(true);
        const chk = runSync({ ...both, checkOnly: true });
        expect(out(chk)).not.toContain("conflict");
        expect(chk.exitCode).toBe(0);
      }
    }
  });

  test("a ledger written before shared links recorded their physical destination still loads and is upgraded by the next sync", () => {
    const { root, home, hub, both, ledger } = sharedThird();
    expect(runSync(both).exitCode).toBe(0);
    const statePath = statePathOf(hub, home, root);
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    for (const rec of Object.values(raw.links) as Record<string, unknown>[]) delete rec.physical;
    writeFileSync(statePath, JSON.stringify(raw, null, 2) + "\n");
    expect(Object.keys(ledger().links).length).toBeGreaterThan(0);
    const chk = runSync({ ...both, checkOnly: true });
    expect(out(chk)).toContain("record-shared-link");
    expect(runSync(both).exitCode).toBe(0);
    const again = runSync({ ...both, checkOnly: true });
    expect(again.exitCode).toBe(0);
    split(join(home, ".claude", "skills"));
    const r = runSync(both);
    expect(out(r)).not.toContain("conflict");
    expect(r.exitCode).toBe(0);
  });

  test("a scoped codex links run never retires claude's duplicate record, even under the symlink-free spelling", () => {
    // ~/.codex/skills is a symlink to the real ~/.claude/skills.
    const sb = sandbox();
    mkdirSync(join(sb.home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(sb.home, ".codex"), { recursive: true });
    symlinkSync(join(sb.home, ".claude", "skills"), join(sb.home, ".codex", "skills"));
    const both = sb.opts(sb.home, ["claude:links", "codex:links"]);
    expect(runSync(both).exitCode).toBe(0);
    const claudeKey = join(sb.home, ".claude", "skills", "demo");
    const codexKey = join(sb.home, ".codex", "skills", "demo");
    const statePath = statePathOf(sb.hub, sb.home, sb.root);
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    expect(raw.links[claudeKey]).toBeDefined();
    raw.links[codexKey] = { ...raw.links[claudeKey] };
    writeFileSync(statePath, JSON.stringify(raw, null, 2) + "\n");
    const scoped = sb.opts(sb.home, ["codex:links"]);
    const chk = runSync({ ...scoped, checkOnly: true });
    expect(out(chk)).not.toContain("drop-duplicate-record");
    expect(runSync(scoped).exitCode).toBe(0);
    expect(sb.ledger().links[claudeKey]).toBeDefined();
    split(join(sb.home, ".codex", "skills"));
    const r = runSync(both);
    expect(out(r)).not.toContain("conflict");
    expect(r.exitCode).toBe(0);
  });

  test("scoped runs with hand-made duplicate records never retire an excluded target's record", () => {
    for (const [active, excluded] of [["codex", ".claude"], ["claude", ".codex"]] as const) {
      const { root, home, hub, both, opts, ledger } = sharedThird();
      expect(runSync(both).exitCode).toBe(0);
      const claudeKey = join(home, ".claude", "skills", "demo");
      const codexKey = join(home, ".codex", "skills", "demo");
      const statePath = statePathOf(hub, home, root);
      const raw = JSON.parse(readFileSync(statePath, "utf8"));
      const rec = raw.links[claudeKey] ?? raw.links[codexKey];
      raw.links[claudeKey] = { ...rec };
      raw.links[codexKey] = { ...rec };
      writeFileSync(statePath, JSON.stringify(raw, null, 2) + "\n");
      const scoped = opts(home, [`${active}:links`]);
      expect(out(runSync({ ...scoped, checkOnly: true }))).not.toContain("drop-duplicate-record");
      expect(runSync(scoped).exitCode).toBe(0);
      expect(ledger().links[join(home, excluded, "skills", "demo")]).toBeDefined();
    }
  });

  test("after a split, a shared link the user retargeted or replaced is a conflict and never recorded as shared", () => {
    for (const first of [".claude", ".codex"]) {
      for (const replace of ["retarget", "directory"] as const) {
        const { root, home, hub, both, third } = sharedThird();
        for (let i = 0; i < 2; i++) expect(runSync(both).exitCode).toBe(0);
        split(join(home, first, "skills"));
        const elsewhere = join(root, "elsewhere-demo");
        mkdirSync(elsewhere, { recursive: true });
        unlinkSync(join(third, "demo"));
        if (replace === "retarget") symlinkSync(elsewhere, join(third, "demo"));
        else mkdirSync(join(third, "demo"));
        const statePath = statePathOf(hub, home, root);
        const before = readFileSync(statePath, "utf8");
        const chk = runSync({ ...both, checkOnly: true });
        expect(out(chk)).not.toContain("record-shared-link");
        expect(chk.exitCode).toBe(1);
        const r = runSync(both);
        expect(r.exitCode).toBe(1);
        expect(out(r)).toContain("conflict");
        expect(out(r)).not.toContain("record-shared-link");
        expect(readFileSync(statePath, "utf8")).toBe(before);
        if (replace === "retarget") expect(realpathSync(join(third, "demo"))).toBe(realpathSync(elsewhere));
        else expect(lstatSync(join(third, "demo")).isDirectory()).toBe(true);
      }
    }
  });

  test("a ledger link record whose physical is not a non-empty absolute path is refused, and the ledger is unchanged", () => {
    for (const bad of [5, "", null, ["x"], "relative/path"]) {
      const { root, home, hub, both } = sharedThird();
      expect(runSync(both).exitCode).toBe(0);
      const statePath = statePathOf(hub, home, root);
      const raw = JSON.parse(readFileSync(statePath, "utf8"));
      const rec = Object.values(raw.links)[0] as Record<string, unknown>;
      rec.physical = bad;
      const text = JSON.stringify(raw, null, 2) + "\n";
      writeFileSync(statePath, text);
      const r = runSync(both);
      expect(r.exitCode).toBe(1);
      expect(r.events.filter((e) => e.id === "agent_hub.error").length).toBe(1);
      expect(readFileSync(statePath, "utf8")).toBe(text);
    }
  });
});

