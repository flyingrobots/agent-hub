import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStatePaths, loadOwnershipState } from "../src/state.ts";
import { parseTargetSelector, type SyncOptions } from "../src/types.ts";
import { runSync } from "./jsonl.ts";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function sandbox(agents: string[] = [".claude", ".cursor", ".codex", ".config/opencode"]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-prim-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "skills"), { recursive: true });
  for (const a of agents) mkdirSync(join(home, a), { recursive: true });
  const base: SyncOptions = {
    hubDir: hub,
    homeDir: home,
    xdgConfigHome: join(home, ".config"),
    xdgStateHome: join(home, ".local", "state"),
  };
  const ledger = () => loadOwnershipState(getStatePaths(hub, home, base.xdgStateHome).statePath, hub).state;
  return { home, hub, base, ledger };
}
const put = (p: string, text: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const out = (r: { stdout: string[]; stderr: string[] }) => [...r.stdout, ...r.stderr].join("\n");
const read = (p: string) => readFileSync(p, "utf8");

const COMMAND = `---
description: Review the current diff
argument-hint: "[focus]"
---
Review the changes, focusing on $ARGUMENTS.
`;
const AGENT = `---
description: A careful code reviewer
model: inherit
---
You review code for correctness.
`;

describe("commands and agents from the hub (flyingrobots/agent-hub#12)", () => {
  test("a command syncs to every agent with a commands directory, in each agent's own shape", () => {
    const { home, hub, base } = sandbox();
    put(join(hub, "commands", "review.md"), COMMAND);
    expect(runSync(base).exitCode).toBe(0);
    const claude = read(join(home, ".claude", "commands", "review.md"));
    expect(claude).toContain("description: Review the current diff");
    expect(claude).toContain('argument-hint: "[focus]"');
    expect(claude).toContain("Review the changes, focusing on $ARGUMENTS.");
    const oc = read(join(home, ".config", "opencode", "commands", "review.md"));
    expect(oc).toContain("description: Review the current diff");
    expect(oc).not.toContain("argument-hint");
    expect(read(join(home, ".cursor", "commands", "review.md"))).toBe("Review the changes, focusing on $ARGUMENTS.\n");
    // Codex prompts are deprecated; Antigravity is not installed here.
    expect(existsSync(join(home, ".codex", "prompts"))).toBe(false);
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
    const again = runSync(base);
    expect(again.events.filter((e) => e.id === "agent_hub.op" && e.data.phase === "sync")).toEqual([]);
  });

  test("an agent definition syncs to Claude, OpenCode (as a subagent), Cursor and Codex (TOML)", () => {
    const { home, hub, base } = sandbox();
    put(join(hub, "agents", "reviewer.md"), AGENT);
    expect(runSync(base).exitCode).toBe(0);
    const claude = Bun.YAML.parse(read(join(home, ".claude", "agents", "reviewer.md")).split("---")[1]!) as Record<string, unknown>;
    expect(claude).toEqual({ name: "reviewer", description: "A careful code reviewer", model: "inherit" });
    const oc = Bun.YAML.parse(read(join(home, ".config", "opencode", "agents", "reviewer.md")).split("---")[1]!) as Record<string, unknown>;
    expect(oc).toEqual({ description: "A careful code reviewer", mode: "subagent" });
    const cursor = Bun.YAML.parse(read(join(home, ".cursor", "agents", "reviewer.md")).split("---")[1]!) as Record<string, unknown>;
    expect(cursor).toEqual({ name: "reviewer", description: "A careful code reviewer" });
    expect(Bun.TOML.parse(read(join(home, ".codex", "agents", "reviewer.toml")))).toEqual({
      name: "reviewer",
      description: "A careful code reviewer",
      developer_instructions: "You review code for correctness.\n",
    });
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });

  test("an agent whose root directory does not exist is skipped", () => {
    const { home, hub, base } = sandbox([".claude"]);
    put(join(hub, "commands", "review.md"), COMMAND);
    expect(runSync(base).exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "commands", "review.md"))).toBe(true);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  test("incompatible frontmatter or body fails closed, and nothing is written", () => {
    const bad: Array<[string, string, string]> = [
      ["commands/a.md", "---\ndescription: d\nallowed-tools: Bash\n---\nx\n", "allowed-tools"],
      ["commands/b.md", "---\ndescription: d\n---\nUse $1 here\n", "$1"],
      ["commands/c.md", "---\ndescription: d\n---\nRun !`ls`\n", "!`"],
      ["agents/d.md", "---\ndescription: d\ntools: Read\n---\nx\n", "tools"],
      ["agents/e.md", "---\ndescription: d\nmodel: sonnet\n---\nx\n", "model"],
      ["agents/f.md", "---\nmodel: inherit\n---\nx\n", "description"],
      ["commands/Bad_Name.md", "---\ndescription: d\n---\nx\n", "name"],
      ["commands/g.md", "---\ndescription: d\ntargets:\n  cursor:\n    x: 1\n---\nx\n", "Cursor"],
    ];
    for (const [rel, text, needle] of bad) {
      const { home, hub, base } = sandbox();
      put(join(hub, rel), text);
      const r = runSync(base);
      expect(r.exitCode).toBe(1);
      expect(out(r)).toContain(needle);
      expect(existsSync(join(home, ".claude", "commands"))).toBe(false);
      expect(existsSync(join(home, ".claude", "agents"))).toBe(false);
    }
  });

  test("targets.<agent> adds frontmatter for that agent only", () => {
    const { home, hub, base } = sandbox();
    put(join(hub, "commands", "deploy.md"), "---\ndescription: Deploy\ntargets:\n  claude:\n    allowed-tools: Bash(git push:*)\n---\nDeploy now.\n");
    expect(runSync(base).exitCode).toBe(0);
    expect(read(join(home, ".claude", "commands", "deploy.md"))).toContain("allowed-tools: Bash(git push:*)");
    expect(read(join(home, ".config", "opencode", "commands", "deploy.md"))).not.toContain("allowed-tools");
  });

  test("removing a command prunes the files agent-hub wrote; an edited one is a conflict and kept", () => {
    const { home, hub, base, ledger } = sandbox();
    put(join(hub, "commands", "review.md"), COMMAND);
    put(join(hub, "commands", "keep.md"), COMMAND);
    expect(runSync(base).exitCode).toBe(0);
    writeFileSync(join(home, ".cursor", "commands", "keep.md"), "my edit\n");
    rmSync(join(hub, "commands", "review.md"));
    rmSync(join(hub, "commands", "keep.md"));
    const r = runSync(base);
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain("keep.md");
    expect(read(join(home, ".cursor", "commands", "keep.md"))).toBe("my edit\n");
    const forced = runSync({ ...base, force: true });
    expect(forced.exitCode).toBe(0);
    for (const p of [".claude/commands/review.md", ".cursor/commands/keep.md", ".config/opencode/commands/review.md"]) {
      expect(existsSync(join(home, p))).toBe(false);
    }
    expect(Object.keys(ledger().files)).toEqual([]);
  });

  test("an existing file agent-hub did not write: identical is adopted with --adopt, different is replaced only with --force", () => {
    const { home, hub, base, ledger } = sandbox([".cursor"]);
    put(join(hub, "commands", "review.md"), COMMAND);
    put(join(home, ".cursor", "commands", "review.md"), "Review the changes, focusing on $ARGUMENTS.\n");
    const plain = runSync(base);
    expect(plain.exitCode).toBe(1);
    expect(out(plain)).toContain("--adopt");
    expect(runSync({ ...base, adopt: true }).exitCode).toBe(0);
    expect(ledger().files[join(home, ".cursor", "commands", "review.md")]!.basis).toBe("adopted");
    const other = sandbox([".cursor"]);
    put(join(other.hub, "commands", "review.md"), COMMAND);
    put(join(other.home, ".cursor", "commands", "review.md"), "mine\n");
    expect(runSync(other.base).exitCode).toBe(1);
    expect(read(join(other.home, ".cursor", "commands", "review.md"))).toBe("mine\n");
    expect(runSync({ ...other.base, force: true }).exitCode).toBe(0);
    expect(read(join(other.home, ".cursor", "commands", "review.md"))).toBe("Review the changes, focusing on $ARGUMENTS.\n");
  });

  test("a scoped run writes and prunes only the active targets' files", () => {
    const { home, hub, base } = sandbox();
    put(join(hub, "commands", "review.md"), COMMAND);
    expect(runSync({ ...base, targets: [parseTargetSelector("claude:links")!] }).exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "commands", "review.md"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "commands", "review.md"))).toBe(false);
    expect(runSync({ ...base, targets: [parseTargetSelector("claude:mcp")!] }).exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "commands", "review.md"))).toBe(true);
  });

  test("a write interrupted after the file and before the ledger is reconciled by the next run", () => {
    const { home, hub, base, ledger } = sandbox([".claude"]);
    put(join(hub, "commands", "review.md"), COMMAND);
    const crashed = runSync(base, {
      afterTargetMutate: (j) => {
        if (j.kind === "file-write") throw new Error("simulated crash after write");
      },
    });
    expect(crashed.exitCode).toBe(1);
    expect(existsSync(join(home, ".claude", "commands", "review.md"))).toBe(true);
    expect(ledger().files[join(home, ".claude", "commands", "review.md")]).toBeUndefined();
    const next = runSync(base);
    expect(next.exitCode).toBe(0);
    expect(ledger().files[join(home, ".claude", "commands", "review.md")]).toBeDefined();
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });
});
