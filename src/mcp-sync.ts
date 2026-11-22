#!/usr/bin/env bun
/**
 * Standalone MCP-only entrypoint delegating to the shared Phase 0 / Phase 1 / Phase 2
 * engine in src/mcp.ts + src/state.ts.
 *
 * Supported targets:
 *   - antigravity: ~/.gemini/config/mcp_config.json (JSON, mcpServers.<name>)
 *   - claude:      ~/.claude.json                   (surgical JSON merge of mcpServers.<name>)
 *   - codex:       ~/.codex/config.toml             (lexical TOML edit + semantic preservation guard)
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolveCanonicalHubDir } from "./cli.ts";
import { acquireApplyLock, LockBusyError, releaseApplyLock, type ApplyLockHandle } from "./lock.ts";
import { applyMcpTarget, planMcpSync } from "./mcp.ts";
import {
  executePendingRecovery,
  getStatePaths,
  inspectPendingRecovery,
  loadLegacyV1Manifest,
  loadOwnershipState,
  loadPendingJournal,
} from "./state.ts";
import { ALL_AGENTS, type AgentId, type PlannedOp } from "./types.ts";

let dryRun = false;
let checkOnly = false;
let adopt = false;
let force = false;
let explain = false;
let hubDirArg: string | undefined;
const disownLegacy: Array<{ agent: AgentId; name: string }> = [];

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg === "-n" || arg === "--dry-run") dryRun = true;
  else if (arg === "--check") {
    checkOnly = true;
    dryRun = true;
  } else if (arg === "--adopt") adopt = true;
  else if (arg === "-f" || arg === "--force") force = true;
  else if (arg === "--explain") {
    explain = true;
    dryRun = true;
  } else if (arg === "--dir") {
    hubDirArg = argv[++i];
  } else if (arg === "--disown-legacy") {
    const raw = argv[++i] ?? "";
    const idx = raw.indexOf(":");
    const agent = raw.slice(0, idx);
    const name = raw.slice(idx + 1);
    if (idx <= 0 || !ALL_AGENTS.includes(agent as AgentId) || !name) {
      console.error(`mcp-sync: invalid --disown-legacy "${raw}"`);
      process.exit(2);
    }
    disownLegacy.push({ agent: agent as AgentId, name });
  } else if (arg === "-h" || arg === "--help") {
    console.log(
      "Usage: mcp-sync.ts [--dir <path>] [--dry-run|-n] [--check] [--adopt] [--force] [--explain] [--disown-legacy <agent>:<name>]",
    );
    process.exit(0);
  } else {
    console.error(`mcp-sync: unknown option: ${arg}`);
    process.exit(2);
  }
}

const homeDir = homedir();
const canonicalHubPath = resolveCanonicalHubDir({
  hubDir: hubDirArg,
  envAgentsDir: hubDirArg ? undefined : process.env.AGENTS_DIR,
  homeDir,
  cwd: process.cwd(),
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
});

if (!existsSync(canonicalHubPath) || !statSync(canonicalHubPath).isDirectory()) {
  console.error(`mcp-sync: canonical hub directory not found: ${canonicalHubPath}`);
  process.exit(1);
}

const paths = getStatePaths(canonicalHubPath, homeDir, process.env.XDG_STATE_HOME);

function main(): void {
  if (dryRun) {
    const state = loadOwnershipState(paths.statePath, canonicalHubPath).state;
    const pending = loadPendingJournal(paths.journalPath);
    if (pending) {
      const insp = inspectPendingRecovery(pending, state);
      if (insp.classification === "ambiguous") {
        console.error(`[conflict] pending recovery ambiguous: ${insp.reason}`);
        process.exit(1);
      }
      console.log(`[plan] [pending-recovery] ${insp.classification}: ${insp.reason}`);
      process.exit(checkOnly ? 1 : 0);
    }

    const legacyV1 = loadLegacyV1Manifest(canonicalHubPath, state);
    const { targets, globalOps } = planMcpSync(canonicalHubPath, homeDir, state, legacyV1, {
      adopt,
      force,
      disownLegacy,
    });
    const allOps: PlannedOp[] = [...globalOps, ...targets.flatMap((t) => t.ops)];
    let changes = 0;
    let conflicts = 0;
    for (const op of allOps) {
      if (op.status === "change") {
        changes += 1;
        console.log(`[plan] ${op.action} ${op.destination} — ${op.reason}`);
      } else if (op.status === "conflict" || op.status === "error") {
        conflicts += 1;
        console.error(`[conflict] ${op.reason}${op.nextStep ? ` (${op.nextStep})` : ""}`);
      }
    }
    if (conflicts > 0) {
      console.error(`mcp-sync: ${conflicts} conflict(s) found; refusing to overwrite.`);
      process.exit(1);
    }
    if (checkOnly && changes > 0) {
      console.error(`mcp-sync: out of sync (${changes} change(s) needed).`);
      process.exit(1);
    }
    process.exit(0);
  }

  let lockHandle: ApplyLockHandle | null = null;
  try {
    lockHandle = acquireApplyLock(paths.lockPath, canonicalHubPath);
    let state = loadOwnershipState(paths.statePath, canonicalHubPath).state;

    const pending = loadPendingJournal(paths.journalPath);
    let recoveredPending = false;
    if (pending) {
      const rec = executePendingRecovery(pending, paths.journalPath, state, paths.statePath);
      state = rec.state;
      recoveredPending = rec.report.hadPending;
      for (const act of rec.report.actions) console.log(`[recover] ${act}`);
      if (!rec.report.resolved) {
        console.error(`[conflict] pending recovery ambiguous: ${rec.report.error}`);
        process.exit(1);
      }
    }

    const legacyV1 = loadLegacyV1Manifest(canonicalHubPath, state);
    const { targets, globalOps } = planMcpSync(canonicalHubPath, homeDir, state, legacyV1, {
      adopt,
      force,
      disownLegacy,
    });
    const allOps: PlannedOp[] = [...globalOps, ...targets.flatMap((t) => t.ops)];
    const conflicts = allOps.filter((op) => op.status === "conflict" || op.status === "error");
    if (conflicts.length > 0) {
      for (const c of conflicts) {
        console.error(`[conflict] ${c.reason}${c.nextStep ? ` (${c.nextStep})` : ""}`);
      }
      if (recoveredPending) {
        console.error(
          `mcp-sync: Phase 0 recovery completed above; preflight found ${conflicts.length} conflict(s), so no new Phase 2 changes were applied.`,
        );
      } else {
        console.error(`mcp-sync: ${conflicts.length} conflict(s) found; refusing to overwrite.`);
      }
      process.exit(1);
    }

    const flags = { adopt, force, forceSkill: false };
    for (const target of targets) {
      if (!target.targetMutation && !target.ledgerMutation) continue;
      state = applyMcpTarget(
        target,
        canonicalHubPath,
        state,
        paths.statePath,
        paths.journalPath,
        flags,
      );
      for (const op of target.ops) {
        if (op.status === "change") {
          console.log(`[sync] ${op.action} ${op.destination} — ${op.reason}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof LockBusyError) {
      console.error(`mcp-sync: ${err.message}`);
      process.exit(1);
    }
    console.error(`mcp-sync: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    releaseApplyLock(lockHandle);
  }
}

main();
