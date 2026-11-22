import { existsSync, lstatSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  atomicWriteDurable,
  captureFileSnapshot,
  captureSymlinkOrAbsentSnapshot,
  captureTreeSnapshot,
  fsyncDir,
  isPlainObject,
  parseJsonFile,
  sha256Hex,
  snapshotsEqual,
} from "./paths.ts";
import {
  ALL_AGENTS,
  type AgentId,
  type ApplyHooks,
  type JournalOpKind,
  type LegacyManifestV1,
  type ManagedLinkRecord,
  type ManagedMcpRecord,
  type OwnershipBasis,
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

const VALID_BASES = new Set<string>(["created", "adopted", "forced"]);
const VALID_LINK_KINDS = new Set<string>(["rules", "skill"]);
const VALID_JOURNAL_KINDS = new Set<string>([
  "mcp-write",
  "link-create",
  "link-replace",
  "link-adopt-copy",
  "link-prune",
  "skill-replace",
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function validateLinkRecord(raw: unknown, label: string): ManagedLinkRecord {
  if (!isPlainObject(raw)) {
    throw new Error(`${label}: expected link record object`);
  }
  if (!isNonEmptyString(raw.kind) || !VALID_LINK_KINDS.has(raw.kind)) {
    throw new Error(`${label}: invalid link kind "${String(raw.kind)}"`);
  }
  if (!isNonEmptyString(raw.target)) {
    throw new Error(`${label}: missing or invalid link target`);
  }
  if (!isNonEmptyString(raw.basis) || !VALID_BASES.has(raw.basis)) {
    throw new Error(`${label}: invalid ownership basis "${String(raw.basis)}"`);
  }
  if (!isNonEmptyString(raw.updatedAt)) {
    throw new Error(`${label}: missing or invalid updatedAt timestamp`);
  }
  return {
    kind: raw.kind as "rules" | "skill",
    target: raw.target,
    basis: raw.basis as OwnershipBasis,
    updatedAt: raw.updatedAt,
  };
}

function validateMcpRecord(raw: unknown, label: string): ManagedMcpRecord {
  if (!isPlainObject(raw)) {
    throw new Error(`${label}: expected MCP record object`);
  }
  if (!isNonEmptyString(raw.configPath)) {
    throw new Error(`${label}: missing or invalid configPath`);
  }
  if (!isNonEmptyString(raw.digest)) {
    throw new Error(`${label}: missing or invalid digest`);
  }
  if (!isNonEmptyString(raw.basis) || !VALID_BASES.has(raw.basis)) {
    throw new Error(`${label}: invalid ownership basis "${String(raw.basis)}"`);
  }
  if (!isNonEmptyString(raw.updatedAt)) {
    throw new Error(`${label}: missing or invalid updatedAt timestamp`);
  }
  return {
    configPath: raw.configPath,
    digest: raw.digest,
    basis: raw.basis as OwnershipBasis,
    updatedAt: raw.updatedAt,
  };
}

function validateSnapshot(raw: unknown, label: string): TargetSnapshot {
  if (!isPlainObject(raw) || typeof raw.kind !== "string") {
    throw new Error(`${label}: missing or invalid snapshot object`);
  }
  switch (raw.kind) {
    case "absent":
      return { kind: "absent" };
    case "file":
      if (
        !isNonEmptyString(raw.sha256) ||
        !isNonNegInt(raw.mode) ||
        !isNonNegInt(raw.uid) ||
        !isNonNegInt(raw.gid)
      ) {
        throw new Error(`${label}: invalid file snapshot fields`);
      }
      return {
        kind: "file",
        sha256: raw.sha256,
        mode: raw.mode,
        uid: raw.uid,
        gid: raw.gid,
      };
    case "symlink":
      if (!isNonEmptyString(raw.target) || !isNonNegInt(raw.uid) || !isNonNegInt(raw.gid)) {
        throw new Error(`${label}: invalid symlink snapshot fields`);
      }
      return {
        kind: "symlink",
        target: raw.target,
        uid: raw.uid,
        gid: raw.gid,
      };
    case "tree":
      if (
        (raw.rootKind !== "file" && raw.rootKind !== "dir") ||
        !isNonEmptyString(raw.equivalenceDigest)
      ) {
        throw new Error(`${label}: invalid tree snapshot fields`);
      }
      return {
        kind: "tree",
        rootKind: raw.rootKind,
        equivalenceDigest: raw.equivalenceDigest,
      };
    default:
      throw new Error(`${label}: unknown snapshot kind "${raw.kind}"`);
  }
}

function validateStateDelta(raw: unknown, label: string): StateDelta {
  if (!isPlainObject(raw) || typeof raw.kind !== "string") {
    throw new Error(`${label}: missing or invalid stateDelta`);
  }
  switch (raw.kind) {
    case "none":
      return { kind: "none" };
    case "link-set":
      if (!isNonEmptyString(raw.destination)) {
        throw new Error(`${label}: link-set missing destination`);
      }
      return {
        kind: "link-set",
        destination: raw.destination,
        record: validateLinkRecord(raw.record, `${label}.record`),
      };
    case "link-delete":
      if (!isNonEmptyString(raw.destination)) {
        throw new Error(`${label}: link-delete missing destination`);
      }
      return { kind: "link-delete", destination: raw.destination };
    case "mcp-target": {
      if (!isNonEmptyString(raw.agent) || !ALL_AGENTS.includes(raw.agent as AgentId)) {
        throw new Error(`${label}: mcp-target invalid agent "${String(raw.agent)}"`);
      }
      if (!isPlainObject(raw.nextAgentMcp)) {
        throw new Error(`${label}: mcp-target missing nextAgentMcp object`);
      }
      const nextAgentMcp: Record<string, ManagedMcpRecord> = {};
      for (const [k, v] of Object.entries(raw.nextAgentMcp)) {
        nextAgentMcp[k] = validateMcpRecord(v, `${label}.nextAgentMcp.${k}`);
      }
      if (
        !Array.isArray(raw.resolvedLegacyV1) ||
        !raw.resolvedLegacyV1.every((x) => isNonEmptyString(x))
      ) {
        throw new Error(`${label}: mcp-target invalid resolvedLegacyV1 array`);
      }
      return {
        kind: "mcp-target",
        agent: raw.agent as AgentId,
        nextAgentMcp,
        resolvedLegacyV1: [...raw.resolvedLegacyV1],
      };
    }
    default:
      throw new Error(`${label}: unknown stateDelta kind "${raw.kind}"`);
  }
}

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
 * Strictly observational state loader with full runtime schema validation.
 * Never creates directories or files and never coerces missing fields to "undefined".
 */
export function loadOwnershipState(
  statePath: string,
  canonicalHubPath: string,
): { state: OwnershipStateV2; existsOnDisk: boolean } {
  if (!existsSync(statePath)) {
    return { state: createEmptyState(canonicalHubPath), existsOnDisk: false };
  }
  const raw = parseJsonFile(statePath);
  if (!isPlainObject(raw) || raw.version !== 2) {
    throw new Error(`agent-hub: invalid ownership state file (expected version 2): ${statePath}`);
  }
  if (!isNonNegInt(raw.generation)) {
    throw new Error(`agent-hub: invalid generation in ownership state: ${statePath}`);
  }
  if (typeof raw.hubPath !== "string" || raw.hubPath !== canonicalHubPath) {
    throw new Error(
      `agent-hub: ownership state hubPath mismatch in ${statePath} (expected ${canonicalHubPath}, found ${String(raw.hubPath)})`,
    );
  }
  if (!isPlainObject(raw.links)) {
    throw new Error(`agent-hub: invalid "links" map in ownership state: ${statePath}`);
  }
  if (!isPlainObject(raw.mcp)) {
    throw new Error(`agent-hub: invalid "mcp" map in ownership state: ${statePath}`);
  }
  if (!isPlainObject(raw.resolvedLegacyV1)) {
    throw new Error(`agent-hub: invalid "resolvedLegacyV1" map in ownership state: ${statePath}`);
  }

  const links: Record<string, ManagedLinkRecord> = {};
  for (const [k, v] of Object.entries(raw.links)) {
    if (!isNonEmptyString(k)) {
      throw new Error(`agent-hub: empty link key in ${statePath}`);
    }
    links[k] = validateLinkRecord(v, `${statePath}#links[${k}]`);
  }

  const mcp: Record<AgentId, Record<string, ManagedMcpRecord>> = {
    antigravity: {},
    claude: {},
    codex: {},
  };
  for (const agent of ALL_AGENTS) {
    const agentObj = raw.mcp[agent];
    if (agentObj === undefined) continue;
    if (!isPlainObject(agentObj)) {
      throw new Error(`agent-hub: invalid mcp.${agent} map in ${statePath}`);
    }
    for (const [name, rec] of Object.entries(agentObj)) {
      mcp[agent][name] = validateMcpRecord(rec, `${statePath}#mcp.${agent}.${name}`);
    }
  }

  const resolvedLegacyV1: Record<AgentId, string[]> = {
    antigravity: [],
    claude: [],
    codex: [],
  };
  for (const agent of ALL_AGENTS) {
    const arr = raw.resolvedLegacyV1[agent];
    if (arr === undefined) continue;
    if (!Array.isArray(arr) || !arr.every((x) => isNonEmptyString(x))) {
      throw new Error(`agent-hub: invalid resolvedLegacyV1.${agent} array in ${statePath}`);
    }
    resolvedLegacyV1[agent] = [...arr].sort();
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

  const raw = parseJsonFile(legacyPath);
  if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.managed)) {
    throw new Error(`agent-hub: invalid legacy v1 manifest at ${legacyPath}`);
  }

  const managed: Record<AgentId, Set<string>> = {
    antigravity: new Set(),
    claude: new Set(),
    codex: new Set(),
  };

  const addNames = (agent: AgentId, list: unknown) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      throw new Error(`agent-hub: invalid managed list for ${agent} in ${legacyPath}`);
    }
    const resolvedSet = new Set(state.resolvedLegacyV1[agent]);
    for (const item of list) {
      if (!isNonEmptyString(item)) continue;
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
 * Strictly observational journal loader with full schema validation.
 * Never creates directories or files and fails closed on truncated/corrupt journals.
 */
export function loadPendingJournal(journalPath: string): PendingJournalRecord | null {
  if (!existsSync(journalPath)) return null;
  const raw = parseJsonFile(journalPath);
  if (!isPlainObject(raw) || raw.version !== 1) {
    throw new Error(`agent-hub: corrupt pending recovery journal at ${journalPath}: expected version 1 object`);
  }
  if (!isNonEmptyString(raw.opId)) {
    throw new Error(`agent-hub: corrupt pending recovery journal at ${journalPath}: missing opId`);
  }
  if (!isNonEmptyString(raw.hubPath)) {
    throw new Error(`agent-hub: corrupt pending recovery journal at ${journalPath}: missing hubPath`);
  }
  if (!isNonNegInt(raw.expectedStateGeneration) || !isNonNegInt(raw.targetStateGeneration)) {
    throw new Error(
      `agent-hub: corrupt pending recovery journal at ${journalPath}: invalid state generation fields`,
    );
  }
  if (!isNonEmptyString(raw.kind) || !VALID_JOURNAL_KINDS.has(raw.kind)) {
    throw new Error(
      `agent-hub: corrupt pending recovery journal at ${journalPath}: invalid op kind "${String(raw.kind)}"`,
    );
  }
  if (!isNonEmptyString(raw.destination)) {
    throw new Error(
      `agent-hub: corrupt pending recovery journal at ${journalPath}: missing destination`,
    );
  }
  if (!isPlainObject(raw.authorization) || !isPlainObject(raw.authorization.flags)) {
    throw new Error(
      `agent-hub: corrupt pending recovery journal at ${journalPath}: invalid authorization`,
    );
  }
  const authBasis = raw.authorization.basis;
  if (
    !isNonEmptyString(authBasis) ||
    (!VALID_BASES.has(authBasis) && authBasis !== "managed")
  ) {
    throw new Error(
      `agent-hub: corrupt pending recovery journal at ${journalPath}: invalid authorization.basis`,
    );
  }
  if (typeof raw.authorization.reason !== "string") {
    throw new Error(
      `agent-hub: corrupt pending recovery journal at ${journalPath}: invalid authorization.reason`,
    );
  }
  const f = raw.authorization.flags;
  if (
    typeof f.adopt !== "boolean" ||
    typeof f.force !== "boolean" ||
    typeof f.forceSkill !== "boolean"
  ) {
    throw new Error(
      `agent-hub: corrupt pending recovery journal at ${journalPath}: invalid authorization.flags`,
    );
  }

  const before = validateSnapshot(raw.before, `${journalPath}#before`);
  const after = validateSnapshot(raw.after, `${journalPath}#after`);
  const stateDelta = validateStateDelta(raw.stateDelta, `${journalPath}#stateDelta`);

  if (raw.backupPath !== undefined && !isNonEmptyString(raw.backupPath)) {
    throw new Error(`agent-hub: corrupt pending recovery journal at ${journalPath}: invalid backupPath`);
  }
  if (raw.stagedPath !== undefined && !isNonEmptyString(raw.stagedPath)) {
    throw new Error(`agent-hub: corrupt pending recovery journal at ${journalPath}: invalid stagedPath`);
  }
  if (raw.sourcePath !== undefined && !isNonEmptyString(raw.sourcePath)) {
    throw new Error(`agent-hub: corrupt pending recovery journal at ${journalPath}: invalid sourcePath`);
  }

  return {
    version: 1,
    opId: raw.opId,
    hubPath: raw.hubPath,
    expectedStateGeneration: raw.expectedStateGeneration,
    targetStateGeneration: raw.targetStateGeneration,
    kind: raw.kind as JournalOpKind,
    authorization: {
      flags: { adopt: f.adopt, force: f.force, forceSkill: f.forceSkill },
      basis: authBasis as OwnershipBasis | "managed",
      reason: raw.authorization.reason,
    },
    destination: raw.destination,
    before,
    after,
    backupPath: raw.backupPath as string | undefined,
    stagedPath: raw.stagedPath as string | undefined,
    sourcePath: raw.sourcePath as string | undefined,
    stateDelta,
  };
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
