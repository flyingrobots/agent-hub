export type AgentId = "antigravity" | "claude" | "codex";
export const ALL_AGENTS: readonly AgentId[] = ["antigravity", "claude", "codex"];

export type McpTransport = "stdio" | "http" | "sse";

export type McpServerSpec = {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
};

export type RawMcpDocument = {
  mcp?: unknown;
  overrides?: Record<string, unknown>;
};

export type OwnershipBasis = "created" | "adopted" | "forced";

export type ManagedLinkRecord = {
  kind: "rules" | "skill";
  target: string;
  basis: OwnershipBasis;
  updatedAt: string;
};

export type ManagedMcpRecord = {
  configPath: string;
  digest: string;
  basis: OwnershipBasis;
  updatedAt: string;
};

export type OwnershipStateV2 = {
  version: 2;
  generation: number;
  hubPath: string;
  links: Record<string, ManagedLinkRecord>;
  mcp: Record<AgentId, Record<string, ManagedMcpRecord>>;
  resolvedLegacyV1: Record<AgentId, string[]>;
};

export type LegacyManifestV1 = {
  version: 1;
  managed: Record<AgentId, Set<string>>;
  path: string;
};

export type TargetSnapshot =
  | { kind: "absent" }
  | { kind: "file"; sha256: string; mode: number; uid: number; gid: number }
  | { kind: "symlink"; target: string; uid: number; gid: number }
  | { kind: "tree"; rootKind: "file" | "dir"; equivalenceDigest: string };

export type StateDelta =
  | { kind: "none" }
  | {
      kind: "mcp-target";
      agent: AgentId;
      nextAgentMcp: Record<string, ManagedMcpRecord>;
      resolvedLegacyV1: string[];
    }
  | { kind: "link-set"; destination: string; record: ManagedLinkRecord }
  | { kind: "link-delete"; destination: string };

export type JournalOpKind =
  | "mcp-write"
  | "link-create"
  | "link-replace"
  | "link-adopt-copy"
  | "link-prune"
  | "skill-replace";

export type PendingJournalRecord = {
  version: 1;
  opId: string;
  hubPath: string;
  expectedStateGeneration: number;
  targetStateGeneration: number;
  kind: JournalOpKind;
  authorization: {
    flags: { adopt: boolean; force: boolean; forceSkill: boolean };
    basis: OwnershipBasis | "managed";
    reason: string;
  };
  destination: string;
  before: TargetSnapshot;
  after: TargetSnapshot;
  backupPath?: string;
  stagedPath?: string;
  sourcePath?: string;
  stateDelta: StateDelta;
};

export type RecoveryClassification =
  | "already-completed"
  | "not-applied"
  | "mid-swap"
  | "needs-ledger-reconcile"
  | "ambiguous";

export type RecoveryInspection = {
  classification: RecoveryClassification;
  journal: PendingJournalRecord;
  reason: string;
  nextStep: string;
};

export type RecoveryReport = {
  hadPending: boolean;
  resolved: boolean;
  classification?: RecoveryClassification;
  actions: string[];
  error?: string;
};

export type OpStatus = "ok" | "change" | "conflict" | "error";

export type PlannedOp = {
  domain: "skill" | "link" | "mcp" | "recovery";
  action: string;
  status: OpStatus;
  destination: string;
  observed: string;
  intended: string;
  ownershipBasis: string;
  reason: string;
  nextStep?: string;
  targetMutation: boolean;
  ledgerMutation: boolean;
};

export type SyncOptions = {
  hubDir?: string;
  homeDir?: string;
  cwd?: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  skillSources?: string[];
  skillOnly?: boolean;
  mcpOnly?: boolean;
  forceSkill?: boolean;
  force?: boolean;
  dryRun?: boolean;
  checkOnly?: boolean;
  adopt?: boolean;
  explain?: boolean;
  disownLegacy?: Array<{ agent: AgentId; name: string }>;
};

export type ApplyHooks = {
  /** Called after Phase 1 planning completes and before Phase 2 starts. */
  afterPlanBeforeApply?: () => void;
  /** Called right after writing the journal and before freshness re-check / target mutation. */
  beforeTargetMutate?: (journal: PendingJournalRecord) => void;
  /** Called right after target mutation succeeds and before state commit / journal clear. */
  afterTargetMutate?: (journal: PendingJournalRecord) => void;
  /** Called during skill-replace or link-adopt-copy right after rename(dst, backupPath). */
  afterBackupRename?: (journal: PendingJournalRecord) => void;
  /** Called right after state commit succeeds and before clearing the journal. */
  afterStateCommit?: (journal: PendingJournalRecord) => void;
  /** Called right before ledger-only state commit (after freshness check). */
  beforeLedgerOnlyCommit?: (description: string) => void;
};

export type SyncRunResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
  recovery?: RecoveryReport;
};
