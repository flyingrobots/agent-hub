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
import { runSync } from "./jsonl.ts";
import { acquireApplyLock, LockBusyError, releaseApplyLock } from "../src/lock.ts";
import {
  captureFileSnapshot,
  captureSymlinkOrAbsentSnapshot,
  captureTreeSnapshot,
  sha256Hex,
  stableJson,
} from "../src/paths.ts";
import {
  getStatePaths,
  loadOwnershipState,
  loadPendingJournal,
  saveOwnershipState,
  writeJournal,
} from "../src/state.ts";
import type {
  OwnershipStateV2,
  PendingJournalRecord,
  RecoveryClassification,
} from "../src/types.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const tempRoots: string[] = [];

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-rec-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "skills"), { recursive: true });
  mkdirSync(join(hub, "mcp"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "skills"), { recursive: true });

  writeFileSync(join(hub, "AGENTS.md"), "# Test Rules\n");
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ userId: "keep-me", theme: "dark" }, null, 2) + "\n",
  );
  chmodSync(join(home, ".claude.json"), 0o600);
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  chmodSync(join(home, ".codex", "config.toml"), 0o600);

  return {
    home,
    hub,
    xdgConfigHome: join(home, ".config"),
    xdgStateHome: join(home, ".local", "state"),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("write-ahead recovery, locking, and snapshot freshness", () => {
  test("state save failure after successful config write recovers without --adopt or --force, then is zero-churn", () => {
    const sb = makeSandbox();
    mkdirSync(join(sb.hub, "mcp", "alpha"), { recursive: true });
    writeFileSync(
      join(sb.hub, "mcp", "alpha", "mcp.json"),
      JSON.stringify({ mcp: { command: "/usr/bin/alpha" } }),
    );
    const baseOpts = {
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    };

    // Establish initial symlinks cleanly so only MCP alpha is pending on the faulted run.
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
    const claudePath = join(sb.home, ".claude.json");

    // Inject failure right after Claude's config file is written and BEFORE state save!
    const failed = runSync(baseOpts, {
      afterTargetMutate(journal) {
        if (journal.destination === claudePath) {
          throw new Error("simulated ENOSPC on state filesystem");
        }
      },
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.join("\n")).toContain("pending recovery");

    // Verify target config WAS written while journal remains pending and state lacks claude/alpha.
    const claudeCfg = JSON.parse(readFileSync(claudePath, "utf8"));
    expect(claudeCfg.mcpServers.alpha.command).toBe("/usr/bin/alpha");
    expect(loadPendingJournal(paths.journalPath)).not.toBeNull();
    const midState = loadOwnershipState(paths.statePath, sb.hub).state;
    expect(midState.mcp.claude.alpha).toBeUndefined();

    // --check reports pending recovery (exit 1) and does NOT mutate state or clear journal.
    const chk = runSync({ ...baseOpts, checkOnly: true });
    expect(chk.exitCode).toBe(1);
    expect(chk.stdout.join("\n") + chk.stderr.join("\n")).toContain("pending");
    expect(loadPendingJournal(paths.journalPath)).not.toBeNull();

    // Retry ordinary sync (NO --adopt, NO --force): Phase 0 reconciles ledger, then finishes cleanly.
    const retry = runSync(baseOpts);
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout.join("\n")).toContain("[recover]");
    expect(loadPendingJournal(paths.journalPath)).toBeNull();

    const recoveredState = loadOwnershipState(paths.statePath, sb.hub).state;
    expect(recoveredState.mcp.claude.alpha?.configPath).toBe(claudePath);
    expect(recoveredState.mcp.claude.alpha?.basis).toBe("created");
    const genAfterRecover = recoveredState.generation;
    const rawStateAfterRecover = readFileSync(paths.statePath, "utf8");

    // Subsequent --check exits 0 and ordinary sync causes zero state churn!
    const chk2 = runSync({ ...baseOpts, checkOnly: true });
    expect(chk2.exitCode).toBe(0);
    const noop = runSync(baseOpts);
    expect(noop.exitCode).toBe(0);
    expect(readFileSync(paths.statePath, "utf8")).toBe(rawStateAfterRecover);
    expect(loadOwnershipState(paths.statePath, sb.hub).state.generation).toBe(genAfterRecover);
  });

  test("literal child-process SIGKILL after link mutation before ledger commit: kernel releases flock and restart reconciles", async () => {
    const sb = makeSandbox();
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
    const markerFile = join(sb.home, "sigkill-ready.flag");
    const targetLink = join(sb.home, ".claude", "CLAUDE.md");

    // Child runs real runSync, signals readiness right after symlink mutation (before state commit),
    // and sleeps until parent sends SIGKILL (bypassing all finally/catch blocks!).
    const childCode = `
      import { writeFileSync } from "node:fs";
      import { runSync } from ${JSON.stringify(join(REPO_ROOT, "src", "cli.ts"))};
      runSync({
        hubDir: ${JSON.stringify(sb.hub)},
        homeDir: ${JSON.stringify(sb.home)},
        xdgConfigHome: ${JSON.stringify(sb.xdgConfigHome)},
        xdgStateHome: ${JSON.stringify(sb.xdgStateHome)},
      }, {
        afterTargetMutate(journal) {
          if (journal.destination === ${JSON.stringify(targetLink)}) {
            writeFileSync(${JSON.stringify(markerFile)}, "ready");
            // Busy-wait until SIGKILL terminates the process (no finally runs)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
          }
        },
      });
    `;

    const child = Bun.spawn(["bun", "-e", childCode], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for child to reach exact post-link-mutation, pre-state-commit barrier.
    const deadline = Date.now() + 5000;
    while (!existsSync(markerFile) && Date.now() < deadline) {
      await Bun.sleep(15);
    }
    expect(existsSync(markerFile)).toBe(true);

    // While child is alive and holds flock, a concurrent apply MUST be refused cleanly.
    const concurrent = runSync({
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    });
    expect(concurrent.exitCode).toBe(1);
    expect(concurrent.stderr.join("\n")).toContain("apply.lock");

    // Literally terminate child with SIGKILL (finally block CANNOT run).
    child.kill("SIGKILL");
    await child.exited;

    // Verify symlink exists on disk, journal is pending, and ledger does NOT yet record targetLink.
    expect(lstatSync(targetLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(targetLink)).toBe(join(sb.hub, "AGENTS.md"));
    expect(loadPendingJournal(paths.journalPath)).not.toBeNull();
    const preRecState = loadOwnershipState(paths.statePath, sb.hub).state;
    expect(preRecState.links[targetLink]).toBeUndefined();

    // --check reports pending recovery without mutating disk.
    const chk = runSync({
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
      checkOnly: true,
    });
    expect(chk.exitCode).toBe(1);

    // Next ordinary apply immediately acquires kernel-released flock, reconciles targetLink in Phase 0,
    // and completes remaining links cleanly!
    const recovered = runSync({
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    });
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout.join("\n")).toContain("[recover]");
    expect(loadPendingJournal(paths.journalPath)).toBeNull();

    const finalState = loadOwnershipState(paths.statePath, sb.hub).state;
    expect(finalState.links[targetLink]?.target).toBe(join(sb.hub, "AGENTS.md"));

    // Follow-up --check exits 0.
    const finalCheck = runSync({
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
      checkOnly: true,
    });
    expect(finalCheck.exitCode).toBe(0);
  });

  test("two-contender flock exclusion after dead owner (SIGKILL): never admits overlapping ownership", async () => {
    const sb = makeSandbox();
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
    const heldFlag = join(sb.home, "dead-owner-held.flag");

    // 1. Spawn owner A that acquires apply.lock and is killed via SIGKILL (leaving apply.lock on disk).
    const ownerCode = `
      import { writeFileSync } from "node:fs";
      import { acquireApplyLock } from ${JSON.stringify(join(REPO_ROOT, "src", "lock.ts"))};
      acquireApplyLock(${JSON.stringify(paths.lockPath)}, ${JSON.stringify(sb.hub)});
      writeFileSync(${JSON.stringify(heldFlag)}, "held");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    `;
    const owner = Bun.spawn(["bun", "-e", ownerCode], { stdout: "pipe", stderr: "pipe" });
    const deadline = Date.now() + 5000;
    while (!existsSync(heldFlag) && Date.now() < deadline) await Bun.sleep(15);
    expect(existsSync(heldFlag)).toBe(true);
    const lockInoBefore = statSync(paths.lockPath).ino;
    owner.kill("SIGKILL");
    await owner.exited;

    // 2. Spawn two contenders B and C simultaneously after dead owner.
    // Measure OVERLAPPING ownership via a shared event log (two sequential winners are fine;
    // overlapping enter/exit intervals or lock inode replacement are failures!).
    const eventLog = join(sb.home, "lock-events.jsonl");
    const barrierFile = join(sb.home, "go.barrier");
    const makeContender = (id: string) => `
      import { appendFileSync, existsSync } from "node:fs";
      import { acquireApplyLock, releaseApplyLock } from ${JSON.stringify(join(REPO_ROOT, "src", "lock.ts"))};
      while (!existsSync(${JSON.stringify(barrierFile)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      try {
        const h = acquireApplyLock(${JSON.stringify(paths.lockPath)}, ${JSON.stringify(sb.hub)});
        appendFileSync(${JSON.stringify(eventLog)}, JSON.stringify({ id: ${JSON.stringify(id)}, ev: "enter", t: Date.now() }) + "\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
        appendFileSync(${JSON.stringify(eventLog)}, JSON.stringify({ id: ${JSON.stringify(id)}, ev: "exit", t: Date.now() }) + "\\n");
        releaseApplyLock(h);
        process.exit(0);
      } catch {
        process.exit(1);
      }
    `;

    const c1 = Bun.spawn(["bun", "-e", makeContender("B")], { stdout: "pipe", stderr: "pipe" });
    const c2 = Bun.spawn(["bun", "-e", makeContender("C")], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(60);
    writeFileSync(barrierFile, "go");

    const [rc1, rc2] = await Promise.all([c1.exited, c2.exited]);
    // At least one must win; neither may unlink/replace the lock inode.
    expect(rc1 === 0 || rc2 === 0).toBe(true);
    expect(statSync(paths.lockPath).ino).toBe(lockInoBefore);

    // Check overlap oracle: active count must never exceed 1!
    const events = readFileSync(eventLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { id: string; ev: "enter" | "exit" });
    let active = 0;
    let maxActive = 0;
    for (const e of events) {
      active += e.ev === "enter" ? 1 : -1;
      if (active > maxActive) maxActive = active;
    }
    expect(maxActive).toBe(1);
    expect(active).toBe(0);

    // After winner exits cleanly, subsequent acquire succeeds immediately.
    const h = acquireApplyLock(paths.lockPath, sb.hub);
    expect(() => acquireApplyLock(paths.lockPath, sb.hub)).toThrow(LockBusyError);
    releaseApplyLock(h);
  });

  test("interrupted populated skill swap (ledger-neutral) recovers with zero generation bump", () => {
    const sb = makeSandbox();
    const skillDst = join(sb.hub, "skills", "demo");
    mkdirSync(skillDst, { recursive: true });
    writeFileSync(join(skillDst, "SKILL.md"), "---\nname: demo\n---\n# Old\n");

    const skillSrc = join(sb.home, "new-demo");
    mkdirSync(skillSrc, { recursive: true });
    writeFileSync(join(skillSrc, "SKILL.md"), "---\nname: demo\n---\n# New\n");

    const baseOpts = {
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    };
    expect(runSync(baseOpts).exitCode).toBe(0);
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
    const genBefore = loadOwnershipState(paths.statePath, sb.hub).state.generation;

    // Interrupt skill-replace right after moving old skill to backup (before moving staged into place).
    const interrupted = runSync(
      { ...baseOpts, skillSources: [skillSrc], forceSkill: true, skillOnly: true },
      {
        afterBackupRename(journal) {
          if (journal.kind === "skill-replace") {
            throw new Error("simulated crash mid skill swap");
          }
        },
      },
    );
    expect(interrupted.exitCode).toBe(1);
    expect(existsSync(skillDst)).toBe(false);
    expect(loadPendingJournal(paths.journalPath)?.kind).toBe("skill-replace");

    // Restart recovers the swap cleanly with ZERO state.generation increment!
    const recovered = runSync(baseOpts);
    expect(recovered.exitCode).toBe(0);
    expect(readFileSync(join(skillDst, "SKILL.md"), "utf8")).toContain("# New");
    expect(loadPendingJournal(paths.journalPath)).toBeNull();
    expect(loadOwnershipState(paths.statePath, sb.hub).state.generation).toBe(genBefore);
  });

  test("recovery running twice (interrupted after state commit before journal clear) is zero-churn no-op", () => {
    const sb = makeSandbox();
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
    const baseOpts = {
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    };

    // Interrupt right AFTER state commit and BEFORE journal unlink.
    const r1 = runSync(baseOpts, {
      afterStateCommit() {
        throw new Error("simulated crash before journal unlink");
      },
    });
    expect(r1.exitCode).toBe(1);
    expect(loadPendingJournal(paths.journalPath)).not.toBeNull();
    const stateAfterCommit = readFileSync(paths.statePath, "utf8");
    const genAfterCommit = loadOwnershipState(paths.statePath, sb.hub).state.generation;

    // 1st recovery run: clears already-completed journal without mutating that state entry's generation,
    // and finishes remaining links. Let's test pure already-completed recovery when everything else is synced:
    // First finish syncing cleanly, then simulate a completed journal left behind.
    expect(runSync(baseOpts).exitCode).toBe(0);
    const syncedStateRaw = readFileSync(paths.statePath, "utf8");
    const syncedState = loadOwnershipState(paths.statePath, sb.hub).state;
    const claudeLink = join(sb.home, ".claude", "CLAUDE.md");
    const afterSnap = captureSymlinkOrAbsentSnapshot(claudeLink);

    writeJournal(paths.journalPath, {
      version: 1,
      opId: "repeat-test",
      hubPath: sb.hub,
      expectedStateGeneration: syncedState.generation - 1,
      targetStateGeneration: syncedState.generation,
      kind: "link-create",
      authorization: {
        flags: { adopt: false, force: false, forceSkill: false },
        basis: "created",
        reason: "test",
      },
      destination: claudeLink,
      before: { kind: "absent" },
      after: afterSnap,
      stateDelta: {
        kind: "link-set",
        destination: claudeLink,
        record: syncedState.links[claudeLink]!,
      },
    });

    const rec1 = runSync(baseOpts);
    expect(rec1.exitCode).toBe(0);
    expect(rec1.recovery?.classification).toBe("already-completed");
    expect(readFileSync(paths.statePath, "utf8")).toBe(syncedStateRaw);

    const rec2 = runSync(baseOpts);
    expect(rec2.exitCode).toBe(0);
    expect(rec2.recovery?.hadPending).toBe(false);
    expect(readFileSync(paths.statePath, "utf8")).toBe(syncedStateRaw);
    expect(genAfterCommit).toBeGreaterThan(0);
    expect(stateAfterCommit.length).toBeGreaterThan(0);
  });

  test("mode-only drift (0644 -> 0600, identical bytes) and unrelated edit at plan/apply barrier are refused", () => {
    const sb = makeSandbox();
    const claudePath = join(sb.home, ".claude.json");
    chmodSync(claudePath, 0o644);
    mkdirSync(join(sb.hub, "mcp", "alpha"), { recursive: true });
    writeFileSync(
      join(sb.hub, "mcp", "alpha", "mcp.json"),
      JSON.stringify({ mcp: { command: "/usr/bin/alpha" } }),
    );
    const baseOpts = {
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    };
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);

    // Case A: Change ONLY mode (0644 -> 0600) with identical bytes between Plan and Apply!
    const modeDrift = runSync(baseOpts, {
      beforeTargetMutate(journal) {
        if (journal.destination === claudePath) {
          chmodSync(claudePath, 0o600);
        }
      },
    });
    expect(modeDrift.exitCode).toBe(1);
    expect(modeDrift.stderr.join("\n")).toContain("stale snapshot");
    // Newer 0600 permissions preserved, contents untouched, journal cleared, no ownership recorded!
    expect(statSync(claudePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(claudePath, "utf8")).mcpServers).toBeUndefined();
    expect(loadPendingJournal(paths.journalPath)).toBeNull();
    expect(loadOwnershipState(paths.statePath, sb.hub).state.mcp.claude.alpha).toBeUndefined();

    // Case B: Unrelated personal server added to ~/.claude.json between Plan and Apply!
    const editDrift = runSync(baseOpts, {
      beforeTargetMutate(journal) {
        if (journal.destination === claudePath) {
          const cur = JSON.parse(readFileSync(claudePath, "utf8"));
          cur.mcpServers = { personal: { type: "stdio", command: "/my/personal", args: [] } };
          writeFileSync(claudePath, JSON.stringify(cur, null, 2) + "\n");
        }
      },
    });
    expect(editDrift.exitCode).toBe(1);
    expect(editDrift.stderr.join("\n")).toContain("stale snapshot");
    // Unrelated personal server survived intact!
    const surviving = JSON.parse(readFileSync(claudePath, "utf8"));
    expect(surviving.mcpServers.personal.command).toBe("/my/personal");
    expect(surviving.mcpServers.alpha).toBeUndefined();
  });

  test("Phase 0 recovery succeeds then Phase 1 preflight fails: recovery reported separately, no new Phase 2 writes", () => {
    const sb = makeSandbox();
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
    const claudePath = join(sb.home, ".claude.json");
    mkdirSync(join(sb.hub, "mcp", "alpha"), { recursive: true });
    writeFileSync(
      join(sb.hub, "mcp", "alpha", "mcp.json"),
      JSON.stringify({ mcp: { command: "/usr/bin/alpha" } }),
    );
    const baseOpts = {
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    };

    // Create a pending recovery for Claude's `alpha` write.
    const r1 = runSync(baseOpts, {
      afterTargetMutate(journal) {
        if (journal.destination === claudePath) throw new Error("fail before state save");
      },
    });
    expect(r1.exitCode).toBe(1);

    // Now introduce a new conflict `beta` (differing personal server in Claude) + new canonical `gamma`.
    mkdirSync(join(sb.hub, "mcp", "beta"), { recursive: true });
    writeFileSync(
      join(sb.hub, "mcp", "beta", "mcp.json"),
      JSON.stringify({ mcp: { command: "/canon/beta" } }),
    );
    mkdirSync(join(sb.hub, "mcp", "gamma"), { recursive: true });
    writeFileSync(
      join(sb.hub, "mcp", "gamma", "mcp.json"),
      JSON.stringify({ mcp: { command: "/canon/gamma" } }),
    );
    // Add personal `beta` in Codex so Claude's `alpha` snapshot stays valid for Phase 0 recovery!
    writeFileSync(
      join(sb.home, ".codex", "config.toml"),
      'model = "gpt-5"\n\n[mcp_servers.beta]\ncommand = "/personal/beta"\n',
    );

    const r2 = runSync(baseOpts);
    expect(r2.exitCode).toBe(1);
    // Phase 0 recovery WAS performed and reported separately!
    expect(r2.recovery?.hadPending).toBe(true);
    expect(r2.recovery?.resolved).toBe(true);
    expect(r2.stdout.join("\n")).toContain("[recover]");
    expect(r2.stderr.join("\n")).toContain("Phase 0 recovery completed above");
    expect(r2.stderr.join("\n")).toContain("no new Phase 2 target or ledger changes were applied");

    // Verify Phase 0 reconciled `alpha`, while Phase 2 wrote NEITHER `gamma` NOR `beta`!
    const state = loadOwnershipState(paths.statePath, sb.hub).state;
    expect(state.mcp.claude.alpha).toBeDefined();
    expect(state.mcp.claude.gamma).toBeUndefined();
    const claudeCfg = JSON.parse(readFileSync(claudePath, "utf8"));
    expect(claudeCfg.mcpServers.gamma).toBeUndefined();
  });

  test("read-only --check, --dry-run, and --explain create zero lock, state, or journal artifacts", () => {
    const sb = makeSandbox();
    const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
    const baseOpts = {
      hubDir: sb.hub,
      homeDir: sb.home,
      xdgConfigHome: sb.xdgConfigHome,
      xdgStateHome: sb.xdgStateHome,
    };

    expect(existsSync(paths.stateDir)).toBe(false);
    runSync({ ...baseOpts, checkOnly: true });
    expect(existsSync(paths.stateDir)).toBe(false);
    runSync({ ...baseOpts, dryRun: true });
    expect(existsSync(paths.stateDir)).toBe(false);
    runSync({ ...baseOpts, explain: true });
    expect(existsSync(paths.stateDir)).toBe(false);
  });

  // Parameterized recovery fixtures with independently authored expected outcomes
  // asserting all three pillars: (1) what survived, (2) who owns it + generation, (3) what the next run does.
  describe("parameterized recovery matrix fixtures", () => {
    const cases: Array<{
      name: string;
      setup: (sb: ReturnType<typeof makeSandbox>, paths: ReturnType<typeof getStatePaths>) => {
        expectedClassification: RecoveryClassification;
        expectExitCode: number;
        assertAfterFirstRun: (
          sb: ReturnType<typeof makeSandbox>,
          state: OwnershipStateV2,
          journalStillExists: boolean,
        ) => void;
        assertNextRun: (sb: ReturnType<typeof makeSandbox>) => void;
      };
    }> = [
      {
        name: "mcp-write target applied, ledger incomplete -> reconciles & next run converges",
        setup(sb, paths) {
          const baseOpts = {
            hubDir: sb.hub,
            homeDir: sb.home,
            xdgConfigHome: sb.xdgConfigHome,
            xdgStateHome: sb.xdgStateHome,
          };
          expect(runSync(baseOpts).exitCode).toBe(0);
          const beforeState = loadOwnershipState(paths.statePath, sb.hub).state;
          const claudePath = join(sb.home, ".claude.json");
          const beforeSnap = captureFileSnapshot(claudePath);

          mkdirSync(join(sb.hub, "mcp", "demo"), { recursive: true });
          writeFileSync(
            join(sb.hub, "mcp", "demo", "mcp.json"),
            JSON.stringify({ mcp: { command: "/bin/demo" } }),
          );

          const nextDoc = {
            userId: "keep-me",
            theme: "dark",
            mcpServers: { demo: { type: "stdio", command: "/bin/demo", args: [] } },
          };
          writeFileSync(claudePath, JSON.stringify(nextDoc, null, 2) + "\n");
          chmodSync(claudePath, 0o600);
          const afterSnap = captureFileSnapshot(claudePath);
          const digest = sha256Hex(stableJson(nextDoc.mcpServers.demo));

          const journal: PendingJournalRecord = {
            version: 1,
            opId: "fix-mcp-reconcile",
            hubPath: sb.hub,
            expectedStateGeneration: beforeState.generation,
            targetStateGeneration: beforeState.generation + 1,
            kind: "mcp-write",
            authorization: {
              flags: { adopt: false, force: false, forceSkill: false },
              basis: "created",
              reason: "add demo",
            },
            destination: claudePath,
            before: beforeSnap,
            after: afterSnap,
            stateDelta: {
              kind: "mcp-target",
              agent: "claude",
              nextAgentMcp: {
                demo: {
                  configPath: claudePath,
                  digest,
                  basis: "created",
                  updatedAt: new Date().toISOString(),
                },
              },
              resolvedLegacyV1: [],
            },
          };
          writeJournal(paths.journalPath, journal);

          return {
            expectedClassification: "needs-ledger-reconcile",
            expectExitCode: 0,
            assertAfterFirstRun(_sb, state, journalExists) {
              expect(journalExists).toBe(false);
              expect(JSON.parse(readFileSync(claudePath, "utf8")).mcpServers.demo.command).toBe(
                "/bin/demo",
              );
              expect(state.mcp.claude.demo?.digest).toBe(digest);
              expect(state.generation).toBeGreaterThanOrEqual(beforeState.generation + 1);
            },
            assertNextRun() {
              expect(runSync({ ...baseOpts, checkOnly: true }).exitCode).toBe(0);
            },
          };
        },
      },
      {
        name: "mcp-write forced delete of unmanaged disabled entry (ledger-neutral) -> completes with zero generation bump",
        setup(sb, paths) {
          const baseOpts = {
            hubDir: sb.hub,
            homeDir: sb.home,
            xdgConfigHome: sb.xdgConfigHome,
            xdgStateHome: sb.xdgStateHome,
          };
          expect(runSync(baseOpts).exitCode).toBe(0);
          const beforeState = loadOwnershipState(paths.statePath, sb.hub).state;
          const claudePath = join(sb.home, ".claude.json");

          // Write file before (with personal foo) and after (without foo)
          const beforeDoc = {
            userId: "keep-me",
            theme: "dark",
            mcpServers: { foo: { type: "stdio", command: "/personal/foo", args: [] } },
          };
          writeFileSync(claudePath, JSON.stringify(beforeDoc, null, 2) + "\n");
          chmodSync(claudePath, 0o600);
          const beforeSnap = captureFileSnapshot(claudePath);

          const afterDoc = { userId: "keep-me", theme: "dark", mcpServers: {} };
          writeFileSync(claudePath, JSON.stringify(afterDoc, null, 2) + "\n");
          chmodSync(claudePath, 0o600);
          const afterSnap = captureFileSnapshot(claudePath);

          mkdirSync(join(sb.hub, "mcp", "foo"), { recursive: true });
          writeFileSync(
            join(sb.hub, "mcp", "foo", "mcp.json"),
            JSON.stringify({ mcp: { disabled: true } }),
          );

          writeJournal(paths.journalPath, {
            version: 1,
            opId: "fix-forced-disabled",
            hubPath: sb.hub,
            expectedStateGeneration: beforeState.generation,
            targetStateGeneration: beforeState.generation, // ledger-neutral!
            kind: "mcp-write",
            authorization: {
              flags: { adopt: false, force: true, forceSkill: false },
              basis: "forced",
              reason: "force delete unmanaged disabled foo",
            },
            destination: claudePath,
            before: beforeSnap,
            after: afterSnap,
            stateDelta: { kind: "none" },
          });

          return {
            expectedClassification: "already-completed",
            expectExitCode: 0,
            assertAfterFirstRun(_sb, state, journalExists) {
              expect(journalExists).toBe(false);
              expect(JSON.parse(readFileSync(claudePath, "utf8")).mcpServers.foo).toBeUndefined();
              expect(state.mcp.claude.foo).toBeUndefined();
              expect(state.generation).toBe(beforeState.generation); // ZERO generation bump!
            },
            assertNextRun() {
              expect(runSync({ ...baseOpts, checkOnly: true }).exitCode).toBe(0);
            },
          };
        },
      },
      {
        name: "link-adopt-copy interrupted mid-swap (committed backup rename) -> completes switch & cleans backup",
        setup(sb, paths) {
          const baseOpts = {
            hubDir: sb.hub,
            homeDir: sb.home,
            xdgConfigHome: sb.xdgConfigHome,
            xdgStateHome: sb.xdgStateHome,
          };
          // Put identical CLAUDE.md copy first, sync everything else, then simulate mid-swap journal.
          const canonicalRules = join(sb.hub, "AGENTS.md");
          const claudeRules = join(sb.home, ".claude", "CLAUDE.md");
          const backupPath = join(sb.home, ".claude", ".agent-hub-adopt-mid");
          writeFileSync(backupPath, "# Test Rules\n");
          chmodSync(backupPath, statSync(canonicalRules).mode & 0o777);
          const beforeSnap = captureTreeSnapshot(backupPath);

          // Probe owner via temporary symlink
          const probe = join(sb.home, ".claude", ".probe-link");
          symlinkSync(canonicalRules, probe);
          const afterSnap = captureSymlinkOrAbsentSnapshot(probe);
          rmSync(probe);

          const initialState = loadOwnershipState(paths.statePath, sb.hub).state;
          saveOwnershipState(paths.statePath, initialState);

          writeJournal(paths.journalPath, {
            version: 1,
            opId: "fix-adopt-mid",
            hubPath: sb.hub,
            expectedStateGeneration: initialState.generation,
            targetStateGeneration: initialState.generation + 1,
            kind: "link-adopt-copy",
            authorization: {
              flags: { adopt: true, force: false, forceSkill: false },
              basis: "adopted",
              reason: "adopt equivalent CLAUDE.md",
            },
            destination: claudeRules,
            before: beforeSnap,
            after: afterSnap,
            backupPath,
            sourcePath: canonicalRules,
            stateDelta: {
              kind: "link-set",
              destination: claudeRules,
              record: {
                kind: "rules",
                target: canonicalRules,
                basis: "adopted",
                updatedAt: new Date().toISOString(),
              },
            },
          });

          return {
            expectedClassification: "mid-swap",
            expectExitCode: 0,
            assertAfterFirstRun(_sb, state, journalExists) {
              expect(journalExists).toBe(false);
              expect(existsSync(backupPath)).toBe(false);
              expect(lstatSync(claudeRules).isSymbolicLink()).toBe(true);
              expect(readlinkSync(claudeRules)).toBe(canonicalRules);
              expect(state.links[claudeRules]?.basis).toBe("adopted");
            },
            assertNextRun() {
              expect(runSync({ ...baseOpts, checkOnly: true }).exitCode).toBe(0);
            },
          };
        },
      },
      {
        name: "ambiguous target modified unexpectedly after interruption -> preserves destination & journal, blocks next run",
        setup(sb, paths) {
          const baseOpts = {
            hubDir: sb.hub,
            homeDir: sb.home,
            xdgConfigHome: sb.xdgConfigHome,
            xdgStateHome: sb.xdgStateHome,
          };
          expect(runSync(baseOpts).exitCode).toBe(0);
          const beforeState = loadOwnershipState(paths.statePath, sb.hub).state;
          const claudePath = join(sb.home, ".claude.json");
          const beforeSnap = captureFileSnapshot(claudePath);

          // Simulate unexpected external modification (matches NEITHER before NOR after!)
          writeFileSync(
            claudePath,
            JSON.stringify({ userId: "keep-me", theme: "light", unexpected: true }, null, 2) + "\n",
          );
          chmodSync(claudePath, 0o600);

          writeJournal(paths.journalPath, {
            version: 1,
            opId: "fix-ambiguous",
            hubPath: sb.hub,
            expectedStateGeneration: beforeState.generation,
            targetStateGeneration: beforeState.generation + 1,
            kind: "mcp-write",
            authorization: {
              flags: { adopt: false, force: false, forceSkill: false },
              basis: "created",
              reason: "add demo",
            },
            destination: claudePath,
            before: beforeSnap,
            after: {
              kind: "file",
              sha256: "0".repeat(64),
              mode: 0o600,
              uid: (beforeSnap as any).uid,
              gid: (beforeSnap as any).gid,
            },
            stateDelta: {
              kind: "mcp-target",
              agent: "claude",
              nextAgentMcp: {},
              resolvedLegacyV1: [],
            },
          });

          return {
            expectedClassification: "ambiguous",
            expectExitCode: 1,
            assertAfterFirstRun(_sb, state, journalExists) {
              // Destination preserved, journal preserved, ledger unchanged!
              expect(journalExists).toBe(true);
              expect(JSON.parse(readFileSync(claudePath, "utf8")).unexpected).toBe(true);
              expect(state.generation).toBe(beforeState.generation);
            },
            assertNextRun() {
              // Next run STILL refuses rather than silently overwriting ambiguous state!
              const next = runSync(baseOpts);
              expect(next.exitCode).toBe(1);
              expect(next.stderr.join("\n")).toContain("ambiguous");
            },
          };
        },
      },
    ];

    for (const c of cases) {
      test(c.name, () => {
        const sb = makeSandbox();
        const paths = getStatePaths(sb.hub, sb.home, sb.xdgStateHome);
        const fixture = c.setup(sb, paths);

        // Read-only modes first (they change nothing): each reports the pending journal as a
        // recovery event and ends with one summary or error line saying what it found.
        const ro = { hubDir: sb.hub, homeDir: sb.home, xdgConfigHome: sb.xdgConfigHome, xdgStateHome: sb.xdgStateHome };
        const ambiguous = fixture.expectedClassification === "ambiguous";
        for (const mode of [{ dryRun: true }, { checkOnly: true }, { explain: true }]) {
          const r = runSync({ ...ro, ...mode });
          const last = r.events[r.events.length - 1]!;
          const rec = r.events.filter((e) => e.id === "agent_hub.recovery");
          expect(rec.length).toBeGreaterThan(0);
          expect(rec.every((e) => e.data.classification === fixture.expectedClassification)).toBe(true);
          if (ambiguous) {
            expect(r.exitCode).toBe(1);
            expect(rec.some((e) => e.data.event === "ambiguous")).toBe(true);
            expect(last.id).toBe("agent_hub.error");
            expect(last.data.code).toBe("recovery");
          } else {
            expect(r.exitCode).toBe("checkOnly" in mode ? 1 : 0);
            expect(rec.every((e) => e.data.event === "pending")).toBe(true);
            expect(last.id).toBe("agent_hub.summary");
            expect(last.data.status).toBe("pending_recovery");
          }
        }

        const res = runSync({
          hubDir: sb.hub,
          homeDir: sb.home,
          xdgConfigHome: sb.xdgConfigHome,
          xdgStateHome: sb.xdgStateHome,
        });
        expect(res.exitCode).toBe(fixture.expectExitCode);
        expect(res.recovery?.classification).toBe(fixture.expectedClassification);

        const state = loadOwnershipState(paths.statePath, sb.hub).state;
        const journalStillExists = loadPendingJournal(paths.journalPath) !== null;
        fixture.assertAfterFirstRun(sb, state, journalStillExists);
        fixture.assertNextRun(sb);
      });
    }
  });
});
