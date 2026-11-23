#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { xdgConfigBase } from "./adapters.ts";
import { IMPORT_USAGE, parseSubcommand, PULL_USAGE, runImport, runPull, type ParsedSubcommand, type PullOptions } from "./import-cli.ts";
import { opData, resetOutput, SCHEMAS, schemaEvents, writeEvents, writeFailed, type OutputEvent, type SchemaId } from "./output.ts";
import { applyLinkOp, planLinkSync, type PlannedLinkOp } from "./links.ts";
import {
  acquireApplyLock,
  LockBusyError,
  LockSystemError,
  releaseApplyLock,
  type ApplyLockHandle,
} from "./lock.ts";
import { applyFileOp, planPrimitives, type PlannedFileOp } from "./primitives.ts";
import { EXEC_USAGE, runExecCli, runSecretCli, SECRET_USAGE } from "./vault-cli.ts";
import { applyMcpTarget, planMcpSync, type PlaintextSecretWarning, type PlannedMcpTarget } from "./mcp.ts";
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
       sync-agents import [OPTIONS]     (see sync-agents import --help)
       sync-agents pull --from <agent> <mcp/<name>|skill/<name>> [OPTIONS]
       sync-agents secret set|grant|revoke|list ...   (see sync-agents secret --help)
       sync-agents exec --vault ENV=KEY... -- COMMAND  (see sync-agents exec --help)

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
      --human, --humanize          Print prose instead of JSON Lines (the default output: one
                                   JSON object per line on stdout and stderr, each naming its
                                   schema in "_schema")
      --schema                     Print every output message schema as JSON Lines and exit
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
  filePlans: PlannedFileOp[];
  mcpTargets: PlannedMcpTarget[];
  allOps: PlannedOp[];
  /** Plaintext-secret warnings from the hub's server specs (Phase 2: warn, do not block). */
  warnings: PlaintextSecretWarning[];
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

    // Commands and agents generated from the hub live with rules and skills (the links domain).
    const filePlans: PlannedFileOp[] =
      opts.skillOnly || opts.mcpOnly
        ? []
        : planPrimitives(canonicalHubPath, homeDir, opts.configBase, state, opts.scope.links, {
            adopt: opts.adopt,
            force: opts.force,
          });

    const mcpPlan = opts.skillOnly
      ? { targets: [] as PlannedMcpTarget[], globalOps: [] as PlannedOp[], warnings: [] as PlaintextSecretWarning[] }
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
      ...filePlans.map((f) => f.op),
      ...mcpPlan.globalOps,
      ...mcpPlan.targets.flatMap((t) => t.ops),
    ];

    return {
      stagedSkills,
      linkPlans,
      filePlans,
      mcpTargets: mcpPlan.targets,
      allOps,
      warnings: mcpPlan.warnings,
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
  const events: OutputEvent[] = [];
  // Every printed line is an event: its message goes to stdout/stderr (what --human prints) and
  // the event to `events` (what the default JSON Lines output prints).
  let appliedChanges = 0;
  const emit = (
    stream: "stdout" | "stderr",
    id: SchemaId,
    message: string,
    data: Record<string, unknown> = {},
  ): void => {
    if (id === "agent_hub.op" && data.phase === "sync") appliedChanges += 1;
    const event: OutputEvent = { stream, id, message, data };
    events.push(event);
    (stream === "stdout" ? stdout : stderr).push(message);
    options.onEvent?.(event);
  };
  const done = (exitCode: number, extra: { recovery?: RecoveryReport } = {}): SyncRunResult => ({
    exitCode,
    stdout,
    stderr,
    events,
    ...extra,
  });
  const fail = (code: string, message: string, data: Record<string, unknown> = {}) =>
    emit("stderr", "agent_hub.error", message, { code, ...data });
  // An error message from a lower layer may already carry the command prefix.
  const labeled = (msg: string) => (msg.startsWith(`${cmdLabel}: `) || msg.startsWith("sync-agents: ") || msg.startsWith("mcp-sync: ") ? msg : `${cmdLabel}: ${msg}`);
  const emitWarnings = (warnings: readonly PlaintextSecretWarning[]): void => {
    for (const w of warnings) {
      emit(
        "stderr",
        "agent_hub.warning",
        `[warn] mcp/${w.server}: ${w.field} ${w.reason}; write it as \${env:NAME}, or list "${w.field}" in allowPlaintextFields`,
        { code: "plaintext_secret", server: w.server, field: w.field, reason: w.reason, source: w.source },
      );
    }
  };
  const emitConflict = (op: PlannedOp): void => {
    const next = op.nextStep ? ` (${op.nextStep})` : "";
    emit("stderr", "agent_hub.conflict", `[conflict] ${op.reason}${next}`, {
      reason: op.reason,
      ...(op.nextStep ? { next_step: op.nextStep } : {}),
      op: opData(op),
    });
  };

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
    fail("usage", `${cmdLabel}: --check cannot be combined with --skill`);
    return done(2);
  }
  if (checkOnly && disownLegacy.length > 0) {
    fail("usage", `${cmdLabel}: --check cannot be combined with --disown-legacy`);
    return done(2);
  }

  let scope: TargetScope;
  let configPath: string;
  try {
    const userCfg = readUserConfig(homeDir, xdgConfigHome);
    scope = resolveTargetScope(options.targets, userCfg.disabledTargets);
    configPath = userCfg.configPath;
  } catch (err) {
    fail("config", labeled(err instanceof Error ? err.message : String(err)));
    return done(1);
  }
  const configBase = xdgConfigBase(homeDir, xdgConfigHome);

  if (skillOnly && disownLegacy.length > 0) {
    fail("usage", `${cmdLabel}: --skill-only cannot be combined with --disown-legacy (MCP planning does not run)`);
    return done(2);
  }
  // A disown request is consumed only by its agent's MCP planner; out of scope it would be
  // dropped silently, so refuse it as a usage error instead.
  for (const req of disownLegacy) {
    if (!scope.mcp.has(req.agent)) {
      fail(
        "usage",
        `${cmdLabel}: --disown-legacy ${req.agent}:${req.name} needs ${req.agent}'s MCP config in scope; include "${req.agent}" or "${req.agent}:mcp" in --targets for this run (which replaces disabledTargets), or remove it from disabledTargets`,
      );
      return done(2);
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
    fail("hub_not_found", `${cmdLabel}: canonical hub directory not found: ${canonicalHubPath}`);
    return done(1);
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
      fail("plan", labeled(err instanceof Error ? err.message : String(err)));
      return done(1);
    }

    if (pendingJournal) {
      const inspection = inspectPendingRecovery(pendingJournal, state);
      const isAmbiguous = inspection.classification === "ambiguous";
      const pendingData = {
        classification: inspection.classification,
        destination: pendingJournal.destination,
        reason: inspection.reason,
        next_step: inspection.nextStep,
      };
      if (explain) {
        emit(
          "stdout",
          "agent_hub.recovery",
          [
            `[explain] recovery ${pendingJournal.destination}`,
            `  status:   ${isAmbiguous ? "conflict" : "pending-recovery"} (${inspection.classification})`,
            `  observed: pending journal ${pendingJournal.opId} (${pendingJournal.kind})`,
            `  intended: ${inspection.nextStep}`,
            `  basis:    ${pendingJournal.authorization.basis}`,
            `  reason:   ${inspection.reason}`,
          ].join("\n"),
          { event: "pending", ...pendingData },
        );
      }
      if (isAmbiguous) {
        emit(
          "stderr",
          "agent_hub.recovery",
          `[conflict] pending recovery ambiguous: ${inspection.reason}\n  next: ${inspection.nextStep}`,
          { event: "ambiguous", ...pendingData },
        );
        fail("recovery", `${cmdLabel}: pending recovery is ambiguous; nothing was changed (see the recovery line above).`, {
          detail: inspection.reason,
        });
        return done(1);
      }
      emit(
        "stdout",
        "agent_hub.recovery",
        `[plan] [pending-recovery] ${inspection.classification}: ${inspection.reason}`,
        { event: "pending", ...pendingData },
      );
      if (checkOnly) {
        emit(
          "stderr",
          "agent_hub.summary",
          `${cmdLabel}: pending recovery detected (${inspection.classification}); run sync-agents to reconcile.`,
          { status: "pending_recovery" },
        );
        return done(1);
      }
      emit(
        "stdout",
        "agent_hub.summary",
        `${cmdLabel}: run without --dry-run to complete recovery before planning fresh sync.`,
        { status: "pending_recovery" },
      );
      return done(0);
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
      emitWarnings(plan.warnings);

      for (const op of plan.allOps) {
        if (explain) {
          emit("stdout", "agent_hub.op", formatExplainBlock(op).join("\n"), { phase: "explain", op: opData(op) });
        }
        // --check does not count a re-key as drift, so it does not list one either.
        if (op.status === "change" && !explain && !(checkOnly && REKEY_ACTIONS.has(op.action))) {
          emit("stdout", "agent_hub.op", formatOpSummary("plan", op), { phase: "plan", op: opData(op) });
        } else if (op.status === "conflict" || op.status === "error") {
          emitConflict(op);
        }
      }

      if (plan.conflicts.length > 0) {
        emit("stderr", "agent_hub.summary", `${cmdLabel}: ${plan.conflicts.length} conflict(s) found; refusing to overwrite.`, {
          status: "conflicts",
          conflicts: plan.conflicts.length,
        });
        return done(1);
      }
      // Re-keying a record to the spelling of this run is ledger housekeeping, not drift: --check
      // under another spelling of the same paths stays clean, and any sync performs it.
      const driftOps = plan.changeOps.filter((op) => !REKEY_ACTIONS.has(op.action));
      if (checkOnly && driftOps.length > 0) {
        emit("stderr", "agent_hub.summary", `${cmdLabel}: out of sync (${driftOps.length} change(s) needed).`, {
          status: "out_of_sync",
          changes: driftOps.length,
        });
        return done(1);
      }
      // Every run ends with one summary or error line.
      const pending = checkOnly ? driftOps.length : plan.changeOps.length;
      if (pending === 0) {
        emit("stdout", "agent_hub.summary", `${cmdLabel}: everything is in sync.`, { status: "in_sync", changes: 0 });
      } else {
        emit("stdout", "agent_hub.summary", `${cmdLabel}: ${pending} change(s) planned; nothing was changed.`, {
          status: "planned",
          changes: pending,
        });
      }
      return done(0);
    } catch (err) {
      fail("plan", labeled(err instanceof Error ? err.message : String(err)));
      return done(1);
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
        fail("lock", `${cmdLabel}: ${err.message}`);
        return done(1);
      }
      throw err;
    }

    let state = loadOwnershipState(paths.statePath, canonicalHubPath).state;

    // ---- PHASE 0: WRITE-AHEAD RECOVERY ----
    const pendingJournal = loadPendingJournal(paths.journalPath);
    if (pendingJournal) {
      const inspection = inspectPendingRecovery(pendingJournal, state);
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
        emit("stdout", "agent_hub.recovery", `[recover] ${act}`, { event: "recovered", action: act });
      }
      if (!recoveryReport.resolved) {
        emit("stderr", "agent_hub.recovery", `[conflict] pending recovery ambiguous: ${recoveryReport.error}`, {
          event: "ambiguous",
          classification: recoveryReport.classification ?? inspection.classification,
          destination: pendingJournal.destination,
          reason: String(recoveryReport.error),
          next_step: inspection.nextStep,
        });
        fail("recovery", `${cmdLabel}: pending recovery is ambiguous; nothing new was applied (see the recovery line above).`, {
          detail: String(recoveryReport.error),
        });
        return done(1, { recovery: recoveryReport });
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
    emitWarnings(plan.warnings);

    if (plan.conflicts.length > 0) {
      for (const c of plan.conflicts) emitConflict(c);
      emit(
        "stderr",
        "agent_hub.summary",
        recoveryReport.hadPending
          ? `${cmdLabel}: Phase 0 recovery completed above; preflight found ${plan.conflicts.length} conflict(s), so no new Phase 2 target or ledger changes were applied.`
          : `${cmdLabel}: ${plan.conflicts.length} conflict(s) found; refusing to overwrite.`,
        { status: "conflicts", conflicts: plan.conflicts.length },
      );
      return done(1, { recovery: recoveryReport });
    }

    if (plan.changeOps.length === 0) {
      if (recoveryReport.hadPending) {
        emit("stdout", "agent_hub.summary", `${cmdLabel}: Phase 0 recovery completed; everything is now in sync.`, {
          status: "recovered_in_sync",
          changes: 0,
        });
      } else {
        emit("stdout", "agent_hub.summary", `${cmdLabel}: everything is in sync.`, { status: "in_sync", changes: 0 });
      }
      return done(0, { recovery: recoveryReport });
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
          emit("stdout", "agent_hub.op", formatOpSummary("sync", sk.op), { phase: "sync", op: opData(sk.op) });
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
          emit("stdout", "agent_hub.op", formatOpSummary("sync", lp.op), { phase: "sync", op: opData(lp.op) });
        },
      });
    }

    for (const fp of plan.filePlans) {
      if (fp.op.status !== "change") continue;
      remainingWork.push({
        label: `${fp.op.action} ${fp.dst}`,
        run: () => {
          state = applyFileOp(fp, canonicalHubPath, state, paths.statePath, paths.journalPath, flags, hooks);
          emit("stdout", "agent_hub.op", formatOpSummary("sync", fp.op), { phase: "sync", op: opData(fp.op) });
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
              emit("stdout", "agent_hub.op", formatOpSummary("sync", op), { phase: "sync", op: opData(op) });
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
        const lines = [`${cmdLabel}: apply failed during "${work.label}": ${msg}`];
        if (committed.length > 0) lines.push(`  committed: ${committed.join(", ")}`);
        if (hasPendingJournal) {
          lines.push(
            `  pending recovery: journal retained at ${paths.journalPath}; re-run sync-agents once storage is healthy to reconcile`,
          );
        }
        if (pendingAfter.length > 0) lines.push(`  pending: ${pendingAfter.join(", ")}`);
        fail("apply", lines.join("\n"), {
          detail: msg,
          committed: [...committed],
          pending: pendingAfter,
          ...(hasPendingJournal ? { journal: paths.journalPath } : {}),
        });
        return done(1, { recovery: recoveryReport });
      }
    }

    emit("stdout", "agent_hub.summary", `${cmdLabel}: applied ${appliedChanges} change(s).`, {
      status: "applied",
      changes: appliedChanges,
    });
    return done(0, { recovery: recoveryReport });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      "plan",
      recoveryReport.hadPending
        ? `${cmdLabel}: Phase 0 recovery completed above; preflight failed (${msg}), so no new Phase 2 target or ledger changes were applied.`
        : labeled(msg),
      { detail: msg },
    );
    return done(1, { recovery: recoveryReport });
  } finally {
    if (plan) cleanupStagedTempDirs(plan.stagedSkills.tempDirs);
    releaseApplyLock(lockHandle);
  }
}

export function parseCliArgs(argv: string[]): {
  options: SyncOptions;
  printDir: boolean;
  showHelp: boolean;
  human: boolean;
  showSchema: boolean;
} {
  const options: SyncOptions = {
    skillSources: [],
    disownLegacy: [],
  };
  let printDir = false;
  let showHelp = false;
  let human = false;
  let showSchema = false;

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
    } else if (arg === "--human" || arg === "--humanize") {
      human = true;
    } else if (arg === "--schema") {
      showSchema = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return { options, printDir, showHelp, human, showSchema };
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

/** Options whose next argument is their value, so a value spelled "--human" is not the flag. */
const VALUE_OPTIONS = new Set(["--dir", "--skill", "--targets", "--disown-legacy"]);

/** --human or --humanize as an option (not as another option's value), even when parsing fails. */
export function wantsHuman(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (VALUE_OPTIONS.has(a)) {
      i += 1;
      continue;
    }
    if (a === "--human" || a === "--humanize") return true;
    // Everything after "--" belongs to another program (sync-agents exec).
    if (a === "--") return false;
  }
  return false;
}

/** --help: what the command does, then the schema of every message type it can print. */
export function helpEvents(command: string, usage: string): OutputEvent[] {
  return [
    {
      stream: "stdout",
      id: "agent_hub.help",
      message: usage,
      data: { command, usage, schemas: Object.keys(SCHEMAS) },
    },
    ...schemaEvents(),
  ];
}

/** `sync-agents import` / `pull`: parse, resolve the hub as a sync does, run, print. */
function runSubcommandCli(cmd: "import" | "pull", argv: string[], human: boolean): number {
  let parsed: ParsedSubcommand;
  const usage = cmd === "import" ? IMPORT_USAGE : PULL_USAGE;
  try {
    parsed = parseSubcommand(cmd, argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeEvents([{ stream: "stderr", id: "agent_hub.error", message: `sync-agents ${cmd}: ${msg}\n${usage}`, data: { code: "usage", detail: msg, usage } }], human);
    return 2;
  }
  if (parsed.kind === "help") {
    writeEvents(human ? helpEvents(parsed.command, parsed.usage).slice(0, 1) : helpEvents(parsed.command, parsed.usage), human);
    return 0;
  }
  const hubDir = resolveCanonicalHubDir({
    hubDir: parsed.opts.hubDir,
    envAgentsDir: parsed.opts.hubDir ? undefined : process.env.AGENTS_DIR,
    homeDir: homedir(),
    cwd: process.cwd(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  });
  const onEvent = (e: OutputEvent) => writeEvents([e], human);
  const env = { homeDir: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME, xdgStateHome: process.env.XDG_STATE_HOME };
  const res =
    parsed.kind === "import"
      ? runImport({ ...parsed.opts, ...env, hubDir, onEvent })
      : runPull({ ...(parsed.opts as PullOptions), ...env, hubDir, onEvent });
  return res.exitCode;
}

/**
 * The CLI boundary: parse, run, and print every outcome as events, including usage errors and
 * unexpected throws, so stdout and stderr only ever carry schema'd lines (or prose with --human).
 */
export function cliMain(
  argv: string[],
  command = "sync-agents",
  usage = CLI_USAGE,
  mcpOnly = false,
  // The sync to run; a parameter so a test can prove that a throw becomes an error line.
  run: typeof runSync = runSync,
): number {
  const human = wantsHuman(argv);
  resetOutput(human);
  // A failed write (not a closed pipe) makes the run fail whatever the sync returned.
  const finish = (code: number) => (writeFailed() ? Math.max(code, 1) : code);
  try {
    if (!mcpOnly && (argv[0] === "exec" || argv[0] === "secret")) {
      const cmd = argv[0];
      const usage = cmd === "exec" ? EXEC_USAGE : SECRET_USAGE;
      if (argv[1] === "--help" || argv[1] === "-h") {
        writeEvents(human ? helpEvents(`sync-agents ${cmd}`, usage).slice(0, 1) : helpEvents(`sync-agents ${cmd}`, usage), human);
        return finish(0);
      }
      return finish(cmd === "exec" ? runExecCli(argv.slice(1), human) : runSecretCli(argv.slice(1), human, (dir) =>
        resolveCanonicalHubDir({ hubDir: dir, envAgentsDir: dir ? undefined : process.env.AGENTS_DIR, homeDir: homedir(), cwd: process.cwd(), xdgConfigHome: process.env.XDG_CONFIG_HOME }),
      ));
    }
    if (!mcpOnly && (argv[0] === "import" || argv[0] === "pull")) {
      return finish(runSubcommandCli(argv[0], argv.slice(1), human));
    }
    let parsed;
    try {
      parsed = parseCliArgs(argv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeEvents(
        [{ stream: "stderr", id: "agent_hub.error", message: `${command}: ${msg}\n${usage}`, data: { code: "usage", detail: msg, usage } }],
        human,
      );
      return finish(2);
    }
    if (parsed.showSchema) {
      writeEvents(schemaEvents(), human);
      return finish(0);
    }
    if (parsed.showHelp) {
      // In prose, help is just the usage text.
      writeEvents(human ? helpEvents(command, usage).slice(0, 1) : helpEvents(command, usage), human);
      return finish(0);
    }
    if (parsed.printDir) {
      const dir = resolveCanonicalHubDir({
        hubDir: parsed.options.hubDir,
        envAgentsDir: parsed.options.hubDir ? undefined : process.env.AGENTS_DIR,
        homeDir: homedir(),
        cwd: process.cwd(),
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
      });
      writeEvents([{ stream: "stdout", id: "agent_hub.print_dir", message: dir, data: { hub: dir } }], human);
      return finish(0);
    }
    // Each line is printed as it happens, not buffered until the run ends.
    const res = run({
      ...parsed.options,
      ...(mcpOnly ? { mcpOnly: true } : {}),
      onEvent: (e) => writeEvents([e], human),
    });
    return finish(res.exitCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeEvents(
      [{ stream: "stderr", id: "agent_hub.error", message: `${command}: internal error: ${msg}`, data: { code: "internal", detail: msg } }],
      human,
    );
    return finish(1);
  }
}

if (import.meta.main) {
  // exitCode, not process.exit(): exiting at once drops whatever a slow pipe has not yet taken.
  process.exitCode = cliMain(process.argv.slice(2));
}
