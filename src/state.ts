import { existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  atomicWriteDurable,
  captureFileSnapshot,
  captureSymlinkOrAbsentSnapshot,
  captureTreeSnapshot,
  fsyncDir,
  isPlainObject,
  sha256Hex,
  snapshotsEqual,
} from "./paths.ts";
import {
  ALL_AGENTS,
  type AgentId,
  type ApplyHooks,
  type LegacyManifestV1,
  type ManagedLinkRecord,
  type ManagedMcpRecord,
  type OwnershipStateV2,
  type PendingJournalRecord,
  type RecoveryInspection,
  type RecoveryReport,
  type StateDelta,
  type TargetSnapshot,
} from "./types.ts";

export type StatePaths = {
  stateDir: string;
  statePath: string;
  journalPath: string;
  lockPath: string;
};

export function getStatePaths(
  canonicalHubPath: string,
  homeDir: string,
  xdgStateHome?: string,
): StatePaths {
  const base =
    xdgStateHome && xdgStateHome.length > 0 ? xdgStateHome : join(homeDir, ".local", "state");
  const stateDir = join(base, "agent-hub");
  const hubHash = sha256Hex(canonicalHubPath).slice(0, 16);
  return {
    stateDir,
    statePath: join(stateDir, `state-${hubHash}.json`),
    journalPath: join(stateDir, `journal-${hubHash}.json`),
    lockPath: join(stateDir, "apply.lock"),
  };
}

export function createEmptyState(canonicalHubPath: string): OwnershipStateV2 {
  return {
    version: 2,
    generation: 0,
    hubPath: canonicalHubPath,
    links: {},
    mcp: {
      antigravity: {},
      claude: {},
      codex: {},
    },
    resolvedLegacyV1: {
      antigravity: [],
      claude: [],
      codex: [],
    },
  };
}

/**
 * Strictly observational state loader — never creates directories or files.
 */
export function loadOwnershipState(
  statePath: string,
  canonicalHubPath: string,
): { state: OwnershipStateV2; existsOnDisk: boolean } {
  if (!existsSync(statePath)) {
    return { state: createEmptyState(canonicalHubPath), existsOnDisk: false };
  }
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  if (!isPlainObject(raw) || raw.version !== 2) {
    throw new Error(`agent-hub: invalid ownership state file (expected version 2): ${statePath}`);
  }
  if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || raw.generation < 0) {
    throw new Error(`agent-hub: invalid generation in ownership state: ${statePath}`);
  }
  if (typeof raw.hubPath !== "string" || raw.hubPath !== canonicalHubPath) {
    throw new Error(
      `agent-hub: ownership state hubPath mismatch in ${statePath} (expected ${canonicalHubPath}, found ${String(raw.hubPath)})`,
    );
  }

  const links: Record<string, ManagedLinkRecord> = {};
  if (isPlainObject(raw.links)) {
    for (const [k, v] of Object.entries(raw.links)) {
      if (isPlainObject(v)) {
        links[k] = {
          kind: v.kind as "rules" | "skill",
          target: String(v.target),
          basis: v.basis as "created" | "adopted" | "forced",
          updatedAt: String(v.updatedAt),
        };
      }
    }
  }

  const mcp: Record<AgentId, Record<string, ManagedMcpRecord>> = {
    antigravity: {},
    claude: {},
    codex: {},
  };
  if (isPlainObject(raw.mcp)) {
    for (const agent of ALL_AGENTS) {
      const agentObj = raw.mcp[agent];
      if (isPlainObject(agentObj)) {
        for (const [name, rec] of Object.entries(agentObj)) {
          if (isPlainObject(rec)) {
            mcp[agent][name] = {
              configPath: String(rec.configPath),
              digest: String(rec.digest),
              basis: rec.basis as "created" | "adopted" | "forced",
              updatedAt: String(rec.updatedAt),
            };
          }
        }
      }
    }
  }

  const resolvedLegacyV1: Record<AgentId, string[]> = {
    antigravity: [],
    claude: [],
    codex: [],
  };
  if (isPlainObject(raw.resolvedLegacyV1)) {
    for (const agent of ALL_AGENTS) {
      const arr = raw.resolvedLegacyV1[agent];
      if (Array.isArray(arr)) {
        resolvedLegacyV1[agent] = arr.filter((x): x is string => typeof x === "string").sort();
      }
    }
  }

  return {
    state: {
      version: 2,
      generation: raw.generation,
      hubPath: canonicalHubPath,
      links,
      mcp,
      resolvedLegacyV1,
    },
    existsOnDisk: true,
  };
}

/**
 * Strictly observational legacy v1 `.mcp-managed.json` loader.
 * Maps legacy `gemini` -> `antigravity` and excludes entries already verified
 * in v2 `state.mcp` or retired in `state.resolvedLegacyV1`.
 */
export function loadLegacyV1Manifest(
  canonicalHubPath: string,
  state: OwnershipStateV2,
): LegacyManifestV1 | null {
  const legacyPath = join(canonicalHubPath, ".mcp-managed.json");
  if (!existsSync(legacyPath)) return null;

  const raw = JSON.parse(readFileSync(legacyPath, "utf8")) as unknown;
  if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.managed)) {
    throw new Error(`agent-hub: invalid legacy v1 manifest at ${legacyPath}`);
  }

  const managed: Record<AgentId, Set<string>> = {
    antigravity: new Set(),
    claude: new Set(),
    codex: new Set(),
  };

  const addNames = (agent: AgentId, list: unknown) => {
    if (!Array.isArray(list)) return;
    const resolvedSet = new Set(state.resolvedLegacyV1[agent]);
    for (const item of list) {
      if (typeof item !== "string" || item.length === 0) continue;
      if (Object.prototype.hasOwnProperty.call(state.mcp[agent], item)) continue;
      if (resolvedSet.has(item)) continue;
      managed[agent].add(item);
    }
  };

  addNames("antigravity", raw.managed.gemini);
  addNames("antigravity", raw.managed.antigravity);
  addNames("claude", raw.managed.claude);
  addNames("codex", raw.managed.codex);

  return { version: 1, managed, path: legacyPath };
}

/**
 * Strictly observational journal loader — never creates directories or files.
 */
export function loadPendingJournal(journalPath: string): PendingJournalRecord | null {
  if (!existsSync(journalPath)) return null;
  const raw = JSON.parse(readFileSync(journalPath, "utf8")) as unknown;
  if (!isPlainObject(raw) || raw.version !== 1 || typeof raw.opId !== "string") {
    throw new Error(`agent-hub: corrupt pending recovery journal at ${journalPath}`);
  }
  return raw as PendingJournalRecord;
}

export function applyStateDelta(state: OwnershipStateV2, delta: StateDelta): OwnershipStateV2 {
  if (delta.kind === "none") return state;

  const next: OwnershipStateV2 = {
    version: 2,
    generation: state.generation + 1,
    hubPath: state.hubPath,
    links: { ...state.links },
    mcp: {
      antigravity: { ...state.mcp.antigravity },
      claude: { ...state.mcp.claude },
      codex: { ...state.mcp.codex },
    },
    resolvedLegacyV1: {
      antigravity: [...state.resolvedLegacyV1.antigravity],
      claude: [...state.resolvedLegacyV1.claude],
      codex: [...state.resolvedLegacyV1.codex],
    },
  };

  switch (delta.kind) {
    case "mcp-target": {
      const sortedMcp: Record<string, ManagedMcpRecord> = {};
      for (const k of Object.keys(delta.nextAgentMcp).sort()) {
        sortedMcp[k] = delta.nextAgentMcp[k]!;
      }
      next.mcp[delta.agent] = sortedMcp;
      next.resolvedLegacyV1[delta.agent] = [...new Set(delta.resolvedLegacyV1)].sort();
      break;
    }
    case "link-set": {
      next.links[delta.destination] = delta.record;
      break;
    }
    case "link-delete": {
      delete next.links[delta.destination];
      break;
    }
  }

  // Keep link keys deterministically sorted for stable JSON output.
  const sortedLinks: Record<string, ManagedLinkRecord> = {};
  for (const k of Object.keys(next.links).sort()) {
    sortedLinks[k] = next.links[k]!;
  }
  next.links = sortedLinks;

  return next;
}

export function saveOwnershipState(statePath: string, state: OwnershipStateV2): void {
  atomicWriteDurable(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600, 0o600);
}

export function writeJournal(journalPath: string, record: PendingJournalRecord): void {
  atomicWriteDurable(journalPath, `${JSON.stringify(record, null, 2)}\n`, 0o600, 0o600);
}

export function clearJournal(journalPath: string): void {
  if (existsSync(journalPath)) {
    unlinkSync(journalPath);
    fsyncDir(dirname(journalPath));
  }
}

export function captureSnapshotForExpected(
  targetPath: string,
  expected: TargetSnapshot,
): TargetSnapshot {
  try {
    const st = lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      return captureSymlinkOrAbsentSnapshot(targetPath);
    }
    if (expected.kind === "tree") {
      return captureTreeSnapshot(targetPath);
    }
    if (st.isFile()) {
      return captureFileSnapshot(targetPath);
    }
    return captureTreeSnapshot(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "absent" };
    }
    return {
      kind: "tree",
      rootKind: "dir",
      equivalenceDigest: `unreadable:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Strictly observational recovery classifier implementing the explicit per-operation
 * recovery predicate table. Never mutates targets, backups, state, or journals.
 */
export function inspectPendingRecovery(
  journal: PendingJournalRecord,
  state: OwnershipStateV2,
): RecoveryInspection {
  const gen = state.generation;
  const expectedGen = journal.expectedStateGeneration;
  const targetGen = journal.targetStateGeneration;
  const ledgerMutates = journal.stateDelta.kind !== "none";

  // Verify generation consistency invariant on the journal record itself.
  if (
    (ledgerMutates && targetGen !== expectedGen + 1) ||
    (!ledgerMutates && targetGen !== expectedGen)
  ) {
    return {
      classification: "ambiguous",
      journal,
      reason: `journal ${journal.opId} has inconsistent state generations (expected=${expectedGen}, target=${targetGen}, ledgerMutates=${ledgerMutates})`,
      nextStep: "Inspect journal and destination manually before retrying.",
    };
  }

  const liveAsBefore = captureSnapshotForExpected(journal.destination, journal.before);
  const liveAsAfter = captureSnapshotForExpected(journal.destination, journal.after);

  // 1. Populated skill directory swap (ledger-neutral: targetGen === expectedGen)
  if (journal.kind === "skill-replace") {
    const backupSnap = journal.backupPath
      ? captureSnapshotForExpected(journal.backupPath, journal.before)
      : ({ kind: "absent" } as TargetSnapshot);
    const stagedSnap = journal.stagedPath
      ? captureSnapshotForExpected(journal.stagedPath, journal.after)
      : ({ kind: "absent" } as TargetSnapshot);

    if (gen !== expectedGen) {
      return {
        classification: "ambiguous",
        journal,
        reason: `skill-replace ${journal.destination}: state generation ${gen} does not match expected ${expectedGen}`,
        nextStep: "Inspect canonical skill directory and journal manually.",
      };
    }
    if (snapshotsEqual(liveAsAfter, journal.after)) {
      return {
        classification: "already-completed",
        journal,
        reason: `skill-replace ${journal.destination} already completed; leftover backup/journal cleanup needed`,
        nextStep: "Run sync-agents to finish cleanup.",
      };
    }
    if (
      liveAsBefore.kind === "absent" &&
      snapshotsEqual(backupSnap, journal.before) &&
      snapshotsEqual(stagedSnap, journal.after)
    ) {
      return {
        classification: "mid-swap",
        journal,
        reason: `skill-replace ${journal.destination} was interrupted after moving previous skill to backup; staged replacement is ready`,
        nextStep: "Run sync-agents to complete the interrupted skill swap.",
      };
    }
    if (snapshotsEqual(liveAsBefore, journal.before) && backupSnap.kind === "absent") {
      return {
        classification: "not-applied",
        journal,
        reason: `skill-replace ${journal.destination} was not applied before interruption`,
        nextStep: "Run sync-agents to clear the unapplied journal and replan.",
      };
    }
    return {
      classification: "ambiguous",
      journal,
      reason: `skill-replace ${journal.destination} observed unexpected destination/backup state since interruption`,
      nextStep: "Preserve evidence and inspect destination, backup, and staged paths manually.",
    };
  }

  // 2. Copy adoption (file/dir -> symlink; ledger-mutating: targetGen === expectedGen + 1).
  // Commitment point: once rename(dst, backupPath) succeeds, the switch to tracking the
  // canonical source is committed, and recovery completes that authorized switch.
  if (journal.kind === "link-adopt-copy") {
    const backupSnap = journal.backupPath
      ? captureSnapshotForExpected(journal.backupPath, journal.before)
      : ({ kind: "absent" } as TargetSnapshot);
    const backupOk = backupSnap.kind === "absent" || snapshotsEqual(backupSnap, journal.before);

    if (gen >= targetGen && snapshotsEqual(liveAsAfter, journal.after) && backupOk) {
      return {
        classification: "already-completed",
        journal,
        reason: `link-adopt-copy ${journal.destination} already completed and recorded in ledger; cleanup needed`,
        nextStep: "Run sync-agents to remove leftover backup and journal.",
      };
    }
    if (gen === expectedGen && snapshotsEqual(liveAsAfter, journal.after) && backupOk) {
      return {
        classification: "needs-ledger-reconcile",
        journal,
        reason: `link-adopt-copy ${journal.destination} created symlink, but ownership ledger update did not complete`,
        nextStep: "Run sync-agents to reconcile ownership ledger and remove backup.",
      };
    }
    if (
      gen === expectedGen &&
      liveAsAfter.kind === "absent" &&
      snapshotsEqual(backupSnap, journal.before)
    ) {
      return {
        classification: "mid-swap",
        journal,
        reason: `link-adopt-copy ${journal.destination} moved destination to backup before creating symlink`,
        nextStep: "Run sync-agents to complete the committed switch and reconcile ownership.",
      };
    }
    if (
      gen === expectedGen &&
      snapshotsEqual(liveAsBefore, journal.before) &&
      backupSnap.kind === "absent"
    ) {
      return {
        classification: "not-applied",
        journal,
        reason: `link-adopt-copy ${journal.destination} was not applied before interruption`,
        nextStep: "Run sync-agents to clear the unapplied journal and replan.",
      };
    }
    return {
      classification: "ambiguous",
      journal,
      reason: `link-adopt-copy ${journal.destination} observed unexpected destination/backup or ledger state since interruption`,
      nextStep: "Preserve destination, backup, and journal; inspect manually.",
    };
  }

  // 3. Forced removal of unmanaged disabled MCP entry (ledger-neutral: targetGen === expectedGen)
  if (journal.kind === "mcp-write" && !ledgerMutates) {
    if (gen !== expectedGen) {
      return {
        classification: "ambiguous",
        journal,
        reason: `ledger-neutral mcp-write ${journal.destination}: state generation ${gen} does not match expected ${expectedGen}`,
        nextStep: "Inspect target config and ownership ledger manually.",
      };
    }
    if (snapshotsEqual(liveAsAfter, journal.after)) {
      return {
        classification: "already-completed",
        journal,
        reason: `mcp-write ${journal.destination} (ledger-neutral) already completed; journal cleanup needed`,
        nextStep: "Run sync-agents to clear the completed journal.",
      };
    }
    if (snapshotsEqual(liveAsBefore, journal.before)) {
      return {
        classification: "not-applied",
        journal,
        reason: `mcp-write ${journal.destination} (ledger-neutral) was not applied before interruption`,
        nextStep: "Run sync-agents to clear the unapplied journal and replan.",
      };
    }
    return {
      classification: "ambiguous",
      journal,
      reason: `mcp-write ${journal.destination} changed unexpectedly after interruption`,
      nextStep: "Preserve destination and journal; inspect manually.",
    };
  }

  // 4. Standard ledger-mutating single-target operations:
  //    mcp-write (add/update/managed-remove), link-create, link-replace, link-prune
  if (gen >= targetGen && snapshotsEqual(liveAsAfter, journal.after)) {
    return {
      classification: "already-completed",
      journal,
      reason: `${journal.kind} ${journal.destination} already completed and recorded in ledger; journal cleanup needed`,
      nextStep: "Run sync-agents to clear the completed journal.",
    };
  }
  if (gen === expectedGen && snapshotsEqual(liveAsAfter, journal.after)) {
    return {
      classification: "needs-ledger-reconcile",
      journal,
      reason: `${journal.kind} ${journal.destination} applied to target, but ownership ledger update did not complete`,
      nextStep: "Run sync-agents to reconcile the ownership ledger.",
    };
  }
  if (gen === expectedGen && snapshotsEqual(liveAsBefore, journal.before)) {
    return {
      classification: "not-applied",
      journal,
      reason: `${journal.kind} ${journal.destination} was not applied before interruption`,
      nextStep: "Run sync-agents to clear the unapplied journal and replan.",
    };
  }

  return {
    classification: "ambiguous",
    journal,
    reason: `${journal.kind} ${journal.destination} observed unexpected target or ledger state since interruption`,
    nextStep: "Preserve destination and journal; inspect manually before retrying.",
  };
}

/**
 * Phase 0: Execute recovery for a pending journal record (apply mode only).
 * Returns updated OwnershipStateV2 and a structured RecoveryReport reported
 * separately from any subsequent Phase 1 preflight or Phase 2 apply results.
 */
export function executePendingRecovery(
  journal: PendingJournalRecord,
  journalPath: string,
  state: OwnershipStateV2,
  statePath: string,
  hooks?: ApplyHooks,
): { state: OwnershipStateV2; report: RecoveryReport } {
  const inspection = inspectPendingRecovery(journal, state);
  const actions: string[] = [];

  switch (inspection.classification) {
    case "ambiguous": {
      return {
        state,
        report: {
          hadPending: true,
          resolved: false,
          classification: "ambiguous",
          actions,
          error: `${inspection.reason} (${inspection.nextStep})`,
        },
      };
    }

    case "already-completed": {
      if (journal.backupPath && existsSync(journal.backupPath)) {
        rmSync(journal.backupPath, { recursive: true, force: true });
        fsyncDir(dirname(journal.backupPath));
        actions.push(`removed leftover backup ${journal.backupPath}`);
      }
      if (journal.stagedPath && existsSync(journal.stagedPath)) {
        rmSync(journal.stagedPath, { recursive: true, force: true });
        fsyncDir(dirname(journal.stagedPath));
        actions.push(`removed leftover staging dir ${journal.stagedPath}`);
      }
      clearJournal(journalPath);
      actions.push(`cleared already-completed journal for ${journal.kind} ${journal.destination}`);
      return {
        state,
        report: {
          hadPending: true,
          resolved: true,
          classification: "already-completed",
          actions,
        },
      };
    }

    case "not-applied": {
      if (journal.stagedPath && existsSync(journal.stagedPath)) {
        rmSync(journal.stagedPath, { recursive: true, force: true });
        fsyncDir(dirname(journal.stagedPath));
        actions.push(`removed unused staging dir ${journal.stagedPath}`);
      }
      clearJournal(journalPath);
      actions.push(`cleared unapplied journal for ${journal.kind} ${journal.destination}`);
      return {
        state,
        report: {
          hadPending: true,
          resolved: true,
          classification: "not-applied",
          actions,
        },
      };
    }

    case "mid-swap": {
      if (journal.kind === "skill-replace") {
        if (!journal.stagedPath || !journal.backupPath) {
          return {
            state,
            report: {
              hadPending: true,
              resolved: false,
              classification: "ambiguous",
              actions,
              error: `skill-replace journal missing stagedPath or backupPath`,
            },
          };
        }
        renameSync(journal.stagedPath, journal.destination);
        fsyncDir(dirname(journal.destination));
        const liveAfter = captureSnapshotForExpected(journal.destination, journal.after);
        if (!snapshotsEqual(liveAfter, journal.after)) {
          return {
            state,
            report: {
              hadPending: true,
              resolved: false,
              classification: "ambiguous",
              actions,
              error: `skill-replace recovery verification failed for ${journal.destination}`,
            },
          };
        }
        rmSync(journal.backupPath, { recursive: true, force: true });
        fsyncDir(dirname(journal.backupPath));
        clearJournal(journalPath);
        actions.push(`completed interrupted skill swap for ${journal.destination}`);
        return {
          state,
          report: {
            hadPending: true,
            resolved: true,
            classification: "mid-swap",
            actions,
          },
        };
      }

      if (journal.kind === "link-adopt-copy") {
        if (journal.after.kind !== "symlink" || !journal.backupPath) {
          return {
            state,
            report: {
              hadPending: true,
              resolved: false,
              classification: "ambiguous",
              actions,
              error: `link-adopt-copy journal missing symlink target or backupPath`,
            },
          };
        }
        symlinkSync(journal.after.target, journal.destination);
        fsyncDir(dirname(journal.destination));
        const liveAfter = captureSnapshotForExpected(journal.destination, journal.after);
        if (!snapshotsEqual(liveAfter, journal.after)) {
          return {
            state,
            report: {
              hadPending: true,
              resolved: false,
              classification: "ambiguous",
              actions,
              error: `link-adopt-copy recovery verification failed for ${journal.destination}`,
            },
          };
        }
        const nextState = applyStateDelta(state, journal.stateDelta);
        saveOwnershipState(statePath, nextState);
        hooks?.afterStateCommit?.(journal);
        rmSync(journal.backupPath, { recursive: true, force: true });
        fsyncDir(dirname(journal.backupPath));
        clearJournal(journalPath);
        actions.push(
          `completed committed copy adoption for ${journal.destination} -> ${journal.after.target} and reconciled ledger (gen ${nextState.generation})`,
        );
        return {
          state: nextState,
          report: {
            hadPending: true,
            resolved: true,
            classification: "mid-swap",
            actions,
          },
        };
      }

      return {
        state,
        report: {
          hadPending: true,
          resolved: false,
          classification: "ambiguous",
          actions,
          error: `unexpected mid-swap classification for ${journal.kind}`,
        },
      };
    }

    case "needs-ledger-reconcile": {
      const nextState = applyStateDelta(state, journal.stateDelta);
      saveOwnershipState(statePath, nextState);
      hooks?.afterStateCommit?.(journal);
      if (journal.backupPath && existsSync(journal.backupPath)) {
        rmSync(journal.backupPath, { recursive: true, force: true });
        fsyncDir(dirname(journal.backupPath));
        actions.push(`removed adopted backup ${journal.backupPath}`);
      }
      clearJournal(journalPath);
      actions.push(
        `reconciled pending ownership ledger update for ${journal.kind} ${journal.destination} (gen ${nextState.generation})`,
      );
      return {
        state: nextState,
        report: {
          hadPending: true,
          resolved: true,
          classification: "needs-ledger-reconcile",
          actions,
        },
      };
    }
  }
}
