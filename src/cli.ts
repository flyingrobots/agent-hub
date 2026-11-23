#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { xdgConfigBase } from "./adapters.ts";
import { applyLinkOp, planLinkSync, type PlannedLinkOp } from "./links.ts";
import {
  acquireApplyLock,
  LockBusyError,
  LockSystemError,
  releaseApplyLock,
  type ApplyLockHandle,
} from "./lock.ts";
import { applyMcpTarget, planMcpSync, type PlannedMcpTarget } from "./mcp.ts";
import { canonicalizeHubPath, isPlainObject, parseJsonFile } from "./paths.ts";
import {
  applySkillInstall,
  cleanupStagedTempDirs,
  planSkillInstalls,
  type StagedSkillPlan,
} from "./skills.ts";
import {
  executePendingRecovery,
  getStatePaths,
  inspectPendingRecovery,
  loadLegacyV1Manifest,
  loadOwnershipState,
  loadPendingJournal,
} from "./state.ts";
import {
  ALL_AGENTS,
  parseTargetSelector,
  resolveTargetScope,
  targetSelectorNames,
  type AgentId,
  type TargetScope,
  type TargetSelector,
  type ApplyHooks,
  type OwnershipStateV2,
  type PlannedOp,
  type RecoveryReport,
  type SyncOptions,
  type SyncRunResult,
} from "./types.ts";

export const CLI_USAGE = `Usage: sync-agents [OPTIONS]

Install skills into your canonical hub directory (default ~/.agents/) and sync
AGENTS.md, skills/, and mcp/ configs across local AI coding agents.

Options:
      --dir <path>                 Override hub directory (default: $AGENTS_DIR, then
                                   ~/.config/agent-hub/config.json "agentsDir", then ~/.agents)
      --skill <src>                Install a skill from a directory, git repo URL,
                                   .bundle, .zip/.skill, or tarball into <hub>/skills/<name>,
                                   then sync installed agents (repeatable)
      --skill-only                 Install --skill source(s) into <hub>/skills/ without syncing
                                   agent targets
      --force-skill                Allow --skill to replace differing canonical skill(s) ONLY
                                   (never authorizes MCP or symlink replacement)
  -f, --force                      Allow replacing differing canonical skills, unmanaged/modified
                                   symlinks, and differing/disabled unmanaged MCP entries
  -n, --dry-run                    Print planned changes without modifying final destinations,
                                   ownership state, journals, or locks
      --check                      Verify symlinks, MCP configs, ownership ledger, and pending
                                   recovery are clean; exit 1 on any drift, conflict, or pending work
      --adopt                      Adopt unmanaged identical symlinks, MCP entries, or strictly
                                   equivalent files/directories into verified v2 ownership
      --disown-legacy <agent>:<name>
                                   Retire an unverified legacy v1 .mcp-managed.json claim without
                                   modifying the target config (requires canonical server removed)
      --explain                    Print observed state, intended state, ownership basis, reason,
                                   and next step for each object without modifying disk
      --targets <csv>              Restrict sync/check/dry-run/explain to specific target(s):
                                   antigravity, claude, codex, cursor, opencode, or one
                                   domain of one, e.g. opencode:mcp or cursor:links
                                   (excluded targets are never pruned). Replaces the
                                   config.json "disabledTargets" list for this run
      --print-dir                  Print the canonical resolved hub directory and exit
  -h, --help                       Show this help`;

type HubUserConfig = {
  agentsDir?: string;
  disabledTargets: TargetSelector[];
  configPath: string;
};

function readUserConfig(homeDir: string, xdgConfigHome?: string): HubUserConfig {
  const cfgPath = join(xdgConfigBase(homeDir, xdgConfigHome), "agent-hub", "config.json");
  if (!existsSync(cfgPath)) return { disabledTargets: [], configPath: cfgPath };
  const parsed = parseJsonFile(cfgPath);
  if (!isPlainObject(parsed)) {
    throw new Error(`${cfgPath}: config.json must contain a JSON object`);
  }
  const agentsDir =
    typeof parsed.agentsDir === "string" && parsed.agentsDir.length > 0
      ? parsed.agentsDir
      : undefined;
  const disabledTargets: TargetSelector[] = [];
  if (parsed.disabledTargets !== undefined) {
    if (!Array.isArray(parsed.disabledTargets)) {
      throw new Error(`${cfgPath}: "disabledTargets" must be an array of target names`);
    }
    for (const item of parsed.disabledTargets) {
      const sel = typeof item === "string" ? parseTargetSelector(item) : null;
      if (!sel) {
        throw new Error(
          `${cfgPath}: unknown target "${String(item)}" in disabledTargets (expected: ${targetSelectorNames()})`,
        );
      }
      disabledTargets.push(sel);
    }
  }
  return { agentsDir, disabledTargets, configPath: cfgPath };
}

/**
 * Read only `agentsDir`, independent of `disabledTargets` validation, so hub resolution (and
 * `--print-dir`) agrees with the bin/sync-agents wrapper even when another field is invalid.
 * A sync run still fails on the invalid field through readUserConfig.
 */
function readConfigAgentsDir(homeDir: string, xdgConfigHome?: string): string | null {
  const cfgPath = join(xdgConfigBase(homeDir, xdgConfigHome), "agent-hub", "config.json");
  try {
    if (!existsSync(cfgPath)) return null;
    const parsed = parseJsonFile(cfgPath);
    if (!isPlainObject(parsed)) return null;
    return typeof parsed.agentsDir === "string" && parsed.agentsDir.length > 0
      ? parsed.agentsDir
      : null;
  } catch {
    return null;
  }
}

export function resolveCanonicalHubDir(opts: {
  hubDir?: string;
  envAgentsDir?: string;
  homeDir: string;
  cwd: string;
  xdgConfigHome?: string;
}): string {
  const raw =
    opts.hubDir ||
    opts.envAgentsDir ||
    readConfigAgentsDir(opts.homeDir, opts.xdgConfigHome) ||
    join(opts.homeDir, ".agents");
  return canonicalizeHubPath(raw, opts.homeDir, opts.cwd);
}

function formatExplainBlock(op: PlannedOp): string[] {
  const lines = [
    `[explain] ${op.domain} ${op.destination}`,
    `  status:   ${op.status} (${op.action})`,
    `  observed: ${op.observed}`,
    `  intended: ${op.intended}`,
    `  basis:    ${op.ownershipBasis}`,
    `  reason:   ${op.reason}`,
  ];
  if (op.nextStep) {
    lines.push(`  next:     ${op.nextStep}`);
  }
  return lines;
}

/** Ledger-only actions that move a record to the current spelling of its path. */
const REKEY_ACTIONS = new Set(["rekey-link-record", "rekey-mcp-record"]);

function formatOpSummary(prefix: string, op: PlannedOp): string {
  const ledgerTag = !op.targetMutation && op.ledgerMutation ? " [state]" : "";
  return `[${prefix}]${ledgerTag} ${op.action} ${op.destination} — ${op.reason}`;
}

type BuiltSyncPlan = {
  stagedSkills: StagedSkillPlan;
  linkPlans: PlannedLinkOp[];
  mcpTargets: PlannedMcpTarget[];
  allOps: PlannedOp[];
  changeOps: PlannedOp[];
  conflicts: PlannedOp[];
};

/**
 * Unified Phase 1 builder shared by BOTH read-only modes (--check, --dry-run, --explain)
 * and apply mode (eliminating duplicate planning orchestration).
 */
function buildSyncPlan(
  canonicalHubPath: string,
  homeDir: string,
  cwd: string,
  state: OwnershipStateV2,
  opts: {
    skillSources: string[];
    skillOnly: boolean;
    mcpOnly: boolean;
    force: boolean;
    forceSkill: boolean;
    adopt: boolean;
    scope: TargetScope;
    configPath: string;
    configBase: string;
    disownLegacy: Array<{ agent: AgentId; name: string }>;
  },
): BuiltSyncPlan {
  const legacyV1 = loadLegacyV1Manifest(canonicalHubPath, state);
  const stagedSkills: StagedSkillPlan =
    !opts.mcpOnly && opts.skillSources.length > 0
      ? planSkillInstalls(opts.skillSources, canonicalHubPath, {
          force: opts.force,
          forceSkill: opts.forceSkill,
          cwd,
        })
      : {
          installs: [],
          plannedSkillNames: [],
          plannedSkillSources: new Map(),
          tempDirs: [],
        };

  try {
    const linkPlans: PlannedLinkOp[] =
      opts.skillOnly || opts.mcpOnly
        ? []
        : planLinkSync(canonicalHubPath, homeDir, state, stagedSkills.plannedSkillNames, {
            adopt: opts.adopt,
            force: opts.force,
            activeTargets: opts.scope.links,
            configBase: opts.configBase,
            plannedSkillSources: stagedSkills.plannedSkillSources,
          });

    const mcpPlan = opts.skillOnly
      ? { targets: [] as PlannedMcpTarget[], globalOps: [] as PlannedOp[] }
      : planMcpSync(canonicalHubPath, homeDir, state, legacyV1, {
          adopt: opts.adopt,
          force: opts.force,
          activeTargets: opts.scope.mcp,
          configPath: opts.configPath,
          configBase: opts.configBase,
          disownLegacy: opts.disownLegacy,
        });

    const allOps: PlannedOp[] = [
      ...stagedSkills.installs.map((s) => s.op),
      ...linkPlans.map((l) => l.op),
      ...mcpPlan.globalOps,
      ...mcpPlan.targets.flatMap((t) => t.ops),
    ];

    return {
      stagedSkills,
      linkPlans,
      mcpTargets: mcpPlan.targets,
      allOps,
      changeOps: allOps.filter((op) => op.status === "change"),
      conflicts: allOps.filter((op) => op.status === "conflict" || op.status === "error"),
    };
  } catch (err) {
    cleanupStagedTempDirs(stagedSkills.tempDirs);
    throw err;
  }
}

export function runSync(options: SyncOptions, hooks?: ApplyHooks): SyncRunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const xdgConfigHome = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const xdgStateHome = options.xdgStateHome ?? process.env.XDG_STATE_HOME;
  const skillSources = options.skillSources ?? [];
  const skillOnly = Boolean(options.skillOnly);
  const mcpOnly = Boolean(options.mcpOnly);
  const forceSkill = Boolean(options.forceSkill);
  const force = Boolean(options.force);
  const checkOnly = Boolean(options.checkOnly);
  const explain = Boolean(options.explain);
  const dryRun = Boolean(options.dryRun || checkOnly || explain);
  const adopt = Boolean(options.adopt);
  const disownLegacy = options.disownLegacy ?? [];
  const cmdLabel = mcpOnly ? "mcp-sync" : "sync-agents";

  if (checkOnly && skillSources.length > 0) {
    stderr.push(`${cmdLabel}: --check cannot be combined with --skill`);
    return { exitCode: 2, stdout, stderr };
  }
  if (checkOnly && disownLegacy.length > 0) {
    stderr.push(`${cmdLabel}: --check cannot be combined with --disown-legacy`);
    return { exitCode: 2, stdout, stderr };
  }

  let scope: TargetScope;
  let configPath: string;
  try {
    const userCfg = readUserConfig(homeDir, xdgConfigHome);
    scope = resolveTargetScope(options.targets, userCfg.disabledTargets);
    configPath = userCfg.configPath;
  } catch (err) {
    stderr.push(`${cmdLabel}: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, stdout, stderr };
  }
  const configBase = xdgConfigBase(homeDir, xdgConfigHome);

  if (skillOnly && disownLegacy.length > 0) {
    stderr.push(`${cmdLabel}: --skill-only cannot be combined with --disown-legacy (MCP planning does not run)`);
    return { exitCode: 2, stdout, stderr };
  }
  // A disown request is consumed only by its agent's MCP planner; out of scope it would be
  // dropped silently, so refuse it as a usage error instead.
  for (const req of disownLegacy) {
    if (!scope.mcp.has(req.agent)) {
      stderr.push(
        `${cmdLabel}: --disown-legacy ${req.agent}:${req.name} needs ${req.agent}'s MCP config in scope; include "${req.agent}" or "${req.agent}:mcp" in --targets for this run (which replaces disabledTargets), or remove it from disabledTargets`,
      );
      return { exitCode: 2, stdout, stderr };
    }
  }

  const canonicalHubPath = resolveCanonicalHubDir({
    hubDir: options.hubDir,
    envAgentsDir: options.hubDir ? undefined : process.env.AGENTS_DIR,
    homeDir,
    cwd,
    xdgConfigHome,
  });

  if (!existsSync(canonicalHubPath) || !statSync(canonicalHubPath).isDirectory()) {
    stderr.push(`${cmdLabel}: canonical hub directory not found: ${canonicalHubPath}`);
    return { exitCode: 1, stdout, stderr };
  }

  const paths = getStatePaths(canonicalHubPath, homeDir, xdgStateHome);

  // ---- READ-ONLY OBSERVATIONAL MODES (--check / --dry-run / --explain) ----
  // Strictly nonmutating: NEVER acquires apply.lock, NEVER creates state/journal directories or files.
  if (dryRun) {
    let state;
    let pendingJournal;
    try {
      state = loadOwnershipState(paths.statePath, canonicalHubPath).state;
      pendingJournal = loadPendingJournal(paths.journalPath);
    } catch (err) {
      stderr.push(`${cmdLabel}: ${err instanceof Error ? err.message : String(err)}`);
      return { exitCode: 1, stdout, stderr };
    }

    if (pendingJournal) {
      const inspection = inspectPendingRecovery(pendingJournal, state);
      const isAmbiguous = inspection.classification === "ambiguous";
      if (explain) {
        stdout.push(
          `[explain] recovery ${pendingJournal.destination}`,
          `  status:   ${isAmbiguous ? "conflict" : "pending-recovery"} (${inspection.classification})`,
          `  observed: pending journal ${pendingJournal.opId} (${pendingJournal.kind})`,
          `  intended: ${inspection.nextStep}`,
          `  basis:    ${pendingJournal.authorization.basis}`,
          `  reason:   ${inspection.reason}`,
        );
      }
      if (isAmbiguous) {
        stderr.push(`[conflict] pending recovery ambiguous: ${inspection.reason}`);
        stderr.push(`  next: ${inspection.nextStep}`);
        return { exitCode: 1, stdout, stderr };
      }
      stdout.push(`[plan] [pending-recovery] ${inspection.classification}: ${inspection.reason}`);
      if (checkOnly) {
        stderr.push(
          `${cmdLabel}: pending recovery detected (${inspection.classification}); run sync-agents to reconcile.`,
        );
        return { exitCode: 1, stdout, stderr };
      }
      stdout.push(`${cmdLabel}: run without --dry-run to complete recovery before planning fresh sync.`);
      return { exitCode: 0, stdout, stderr };
    }

    let plan: BuiltSyncPlan | null = null;
    try {
      plan = buildSyncPlan(canonicalHubPath, homeDir, cwd, state, {
        skillSources,
        skillOnly,
        mcpOnly,
        force,
        forceSkill,
        adopt,
        scope,
        configPath,
        configBase,
        disownLegacy,
      });

      for (const op of plan.allOps) {
        if (explain) {
          stdout.push(...formatExplainBlock(op));
        }
        if (op.status === "change" && !explain) {
          stdout.push(formatOpSummary("plan", op));
        } else if (op.status === "conflict" || op.status === "error") {
          const next = op.nextStep ? ` (${op.nextStep})` : "";
          stderr.push(`[conflict] ${op.reason}${next}`);
        }
      }

      if (plan.conflicts.length > 0) {
        stderr.push(`${cmdLabel}: ${plan.conflicts.length} conflict(s) found; refusing to overwrite.`);
        return { exitCode: 1, stdout, stderr };
      }
      // Re-keying a record to the spelling of this run is ledger housekeeping, not drift: --check
      // under another spelling of the same paths stays clean, and any sync performs it.
      const driftOps = plan.changeOps.filter((op) => !REKEY_ACTIONS.has(op.action));
      if (checkOnly && driftOps.length > 0) {
        stderr.push(`${cmdLabel}: out of sync (${driftOps.length} change(s) needed).`);
        return { exitCode: 1, stdout, stderr };
      }
      if ((checkOnly ? driftOps.length : plan.changeOps.length) === 0 && !explain) {
        stdout.push(`${cmdLabel}: everything is in sync.`);
      }
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      stderr.push(`${cmdLabel}: ${err instanceof Error ? err.message : String(err)}`);
      return { exitCode: 1, stdout, stderr };
    } finally {
      if (plan) cleanupStagedTempDirs(plan.stagedSkills.tempDirs);
    }
  }

  // ---- APPLY MODE ----
  let lockHandle: ApplyLockHandle | null = null;
  let plan: BuiltSyncPlan | null = null;
  let recoveryReport: RecoveryReport = { hadPending: false, resolved: true, actions: [] };

  try {
    try {
      lockHandle = acquireApplyLock(paths.lockPath, canonicalHubPath);
    } catch (err) {
      if (err instanceof LockBusyError || err instanceof LockSystemError) {
        stderr.push(`${cmdLabel}: ${err.message}`);
        return { exitCode: 1, stdout, stderr };
      }
      throw err;
    }

    let state = loadOwnershipState(paths.statePath, canonicalHubPath).state;

    // ---- PHASE 0: WRITE-AHEAD RECOVERY ----
    const pendingJournal = loadPendingJournal(paths.journalPath);
    if (pendingJournal) {
      const recovered = executePendingRecovery(
        pendingJournal,
        paths.journalPath,
        state,
        paths.statePath,
        hooks,
      );
      state = recovered.state;
      recoveryReport = recovered.report;
      for (const act of recoveryReport.actions) {
        stdout.push(`[recover] ${act}`);
      }
      if (!recoveryReport.resolved) {
        stderr.push(`[conflict] pending recovery ambiguous: ${recoveryReport.error}`);
        return { exitCode: 1, stdout, stderr, recovery: recoveryReport };
      }
    }

    // ---- PHASE 1: READ-ONLY PREFLIGHT & PLAN ----
    plan = buildSyncPlan(canonicalHubPath, homeDir, cwd, state, {
      skillSources,
      skillOnly,
      mcpOnly,
      force,
      forceSkill,
      adopt,
      scope,
      configPath,
      configBase,
      disownLegacy,
    });

    if (plan.conflicts.length > 0) {
      for (const c of plan.conflicts) {
        const next = c.nextStep ? ` (${c.nextStep})` : "";
        stderr.push(`[conflict] ${c.reason}${next}`);
      }
      if (recoveryReport.hadPending) {
        stderr.push(
          `${cmdLabel}: Phase 0 recovery completed above; preflight found ${plan.conflicts.length} conflict(s), so no new Phase 2 target or ledger changes were applied.`,
        );
      } else {
        stderr.push(`${cmdLabel}: ${plan.conflicts.length} conflict(s) found; refusing to overwrite.`);
      }
      return { exitCode: 1, stdout, stderr, recovery: recoveryReport };
    }

    if (plan.changeOps.length === 0) {
      if (recoveryReport.hadPending) {
        stdout.push(`${cmdLabel}: Phase 0 recovery completed; everything is now in sync.`);
      } else {
        stdout.push(`${cmdLabel}: everything is in sync.`);
      }
      return { exitCode: 0, stdout, stderr, recovery: recoveryReport };
    }

    hooks?.afterPlanBeforeApply?.();

    // ---- PHASE 2: PER-OP WRITE-AHEAD APPLY ----
    const flags = { adopt, force, forceSkill };
    const committed: string[] = [];
    const remainingWork: Array<{ label: string; run: () => void }> = [];

    for (const sk of plan.stagedSkills.installs) {
      if (sk.op.status !== "change") continue;
      remainingWork.push({
        label: `${sk.op.action} ${sk.dstDir}`,
        run: () => {
          applySkillInstall(sk, canonicalHubPath, state, paths.journalPath, flags, hooks);
          stdout.push(formatOpSummary("sync", sk.op));
        },
      });
    }

    for (const lp of plan.linkPlans) {
      if (lp.op.status !== "change") continue;
      remainingWork.push({
        label: `${lp.op.action} ${lp.dst}`,
        run: () => {
          state = applyLinkOp(
            lp,
            canonicalHubPath,
            state,
            paths.statePath,
            paths.journalPath,
            flags,
            hooks,
          );
          stdout.push(formatOpSummary("sync", lp.op));
        },
      });
    }

    for (const mt of plan.mcpTargets) {
      if (!mt.targetMutation && !mt.ledgerMutation) continue;
      remainingWork.push({
        label: `mcp ${mt.agent} (${mt.configPath})`,
        run: () => {
          state = applyMcpTarget(
            mt,
            canonicalHubPath,
            state,
            paths.statePath,
            paths.journalPath,
            flags,
            hooks,
          );
          for (const op of mt.ops) {
            if (op.status === "change") {
              stdout.push(formatOpSummary("sync", op));
            }
          }
        },
      });
    }

    for (let idx = 0; idx < remainingWork.length; idx += 1) {
      const work = remainingWork[idx]!;
      try {
        work.run();
        committed.push(work.label);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const pendingAfter = remainingWork.slice(idx + 1).map((w) => w.label);
        const hasPendingJournal = existsSync(paths.journalPath);
        stderr.push(`${cmdLabel}: apply failed during "${work.label}": ${msg}`);
        if (committed.length > 0) {
          stderr.push(`  committed: ${committed.join(", ")}`);
        }
        if (hasPendingJournal) {
          stderr.push(
            `  pending recovery: journal retained at ${paths.journalPath}; re-run sync-agents once storage is healthy to reconcile`,
          );
        }
        if (pendingAfter.length > 0) {
          stderr.push(`  pending: ${pendingAfter.join(", ")}`);
        }
        return { exitCode: 1, stdout, stderr, recovery: recoveryReport };
      }
    }

    return { exitCode: 0, stdout, stderr, recovery: recoveryReport };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (recoveryReport.hadPending) {
      stderr.push(
        `${cmdLabel}: Phase 0 recovery completed above; preflight failed (${msg}), so no new Phase 2 target or ledger changes were applied.`,
      );
    } else {
      stderr.push(`${cmdLabel}: ${msg}`);
    }
    return { exitCode: 1, stdout, stderr, recovery: recoveryReport };
  } finally {
    if (plan) cleanupStagedTempDirs(plan.stagedSkills.tempDirs);
    releaseApplyLock(lockHandle);
  }
}

export function parseCliArgs(argv: string[]): {
  options: SyncOptions;
  printDir: boolean;
  showHelp: boolean;
} {
  const options: SyncOptions = {
    skillSources: [],
    disownLegacy: [],
  };
  let printDir = false;
  let showHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dir") {
      if (i + 1 >= argv.length) throw new Error("--dir requires a path argument");
      options.hubDir = argv[++i]!;
    } else if (arg.startsWith("--dir=")) {
      const val = arg.slice("--dir=".length);
      if (val.length === 0) throw new Error("--dir requires a non-empty path argument");
      options.hubDir = val;
    } else if (arg === "--skill") {
      if (i + 1 >= argv.length) throw new Error("--skill requires a source argument");
      options.skillSources!.push(argv[++i]!);
    } else if (arg.startsWith("--skill=")) {
      const val = arg.slice("--skill=".length);
      if (val.length === 0) throw new Error("--skill requires a non-empty source argument");
      options.skillSources!.push(val);
    } else if (arg === "--skill-only") {
      options.skillOnly = true;
    } else if (arg === "--force-skill") {
      options.forceSkill = true;
    } else if (arg === "-f" || arg === "--force") {
      options.force = true;
    } else if (arg === "-n" || arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--check") {
      options.checkOnly = true;
    } else if (arg === "--adopt") {
      options.adopt = true;
    } else if (arg === "--explain") {
      options.explain = true;
    } else if (arg === "--targets") {
      if (i + 1 >= argv.length) {
        throw new Error("--targets requires a comma-separated list of targets");
      }
      if (options.targets) throw new Error("--targets may be given only once; list every selector in one comma-separated value");
      options.targets = parseTargetsArg(argv[++i]!);
    } else if (arg.startsWith("--targets=")) {
      if (options.targets) throw new Error("--targets may be given only once; list every selector in one comma-separated value");
      options.targets = parseTargetsArg(arg.slice("--targets=".length));
    } else if (arg === "--disown-legacy") {
      if (i + 1 >= argv.length) {
        throw new Error("--disown-legacy requires an <agent>:<name> argument");
      }
      options.disownLegacy!.push(parseDisownArg(argv[++i]!));
    } else if (arg.startsWith("--disown-legacy=")) {
      options.disownLegacy!.push(parseDisownArg(arg.slice("--disown-legacy=".length)));
    } else if (arg === "--print-dir") {
      printDir = true;
    } else if (arg === "-h" || arg === "--help") {
      showHelp = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return { options, printDir, showHelp };
}

function parseTargetsArg(raw: string): TargetSelector[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(
      `--targets requires at least one target (expected one or more of: ${targetSelectorNames()})`,
    );
  }
  const out: TargetSelector[] = [];
  for (const p of parts) {
    const sel = parseTargetSelector(p);
    if (!sel) {
      throw new Error(`unknown target "${p}" in --targets (expected: ${targetSelectorNames()})`);
    }
    out.push(sel);
  }
  return out;
}

function parseDisownArg(raw: string): { agent: AgentId; name: string } {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(
      `invalid --disown-legacy value "${raw}" (expected <agent>:<name>, e.g. claude:foo)`,
    );
  }
  const agent = raw.slice(0, idx);
  const name = raw.slice(idx + 1);
  if (!ALL_AGENTS.includes(agent as AgentId)) {
    throw new Error(
      `invalid agent "${agent}" in --disown-legacy (expected one of: ${ALL_AGENTS.join(", ")})`,
    );
  }
  return { agent: agent as AgentId, name };
}

if (import.meta.main) {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`sync-agents: ${err instanceof Error ? err.message : String(err)}`);
    console.error(CLI_USAGE);
    process.exit(2);
  }

  if (parsed.showHelp) {
    console.log(CLI_USAGE);
    process.exit(0);
  }

  if (parsed.printDir) {
    const dir = resolveCanonicalHubDir({
      hubDir: parsed.options.hubDir,
      envAgentsDir: parsed.options.hubDir ? undefined : process.env.AGENTS_DIR,
      homeDir: homedir(),
      cwd: process.cwd(),
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
    });
    console.log(dir);
    process.exit(0);
  }

  const res = runSync(parsed.options);
  for (const line of res.stdout) console.log(line);
  for (const line of res.stderr) console.error(line);
  process.exit(res.exitCode);
}
