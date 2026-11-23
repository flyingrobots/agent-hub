export type AgentId = "antigravity" | "claude" | "codex" | "cursor" | "opencode";
export const ALL_AGENTS: readonly AgentId[] = [
  "antigravity",
  "claude",
  "codex",
  "cursor",
  "opencode",
];

export type McpTransport = "stdio" | "http" | "sse";

export type McpServerSpec = {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /**
   * Native fields for one agent that the canonical spec does not model (only in
   * overrides.<agent>); they are added to that agent's compiled entry as written.
   */
  extra?: Record<string, unknown>;
};

export type RawMcpDocument = {
  mcp?: unknown;
  overrides?: Record<string, unknown>;
  /** Field paths (`env.API_KEY`, `headers.Authorization`) whose literal values are intended. */
  allowPlaintextFields?: unknown;
};

export type OwnershipBasis = "created" | "adopted" | "forced";

export type ManagedLinkRecord = {
  kind: "rules" | "skill";
  target: string;
  basis: OwnershipBasis;
  updatedAt: string;
  /**
   * The physical destination, recorded only when several desired spellings name this one link
   * (agents whose skills directories are symlinks to one shared directory). It lets the other
   * spellings keep ownership after the directory holding this record's spelling is split off.
   * Absent in ledgers written before flyingrobots/agent-hub#37, and for every unshared link.
   */
  physical?: string;
};

export type ManagedMcpRecord = {
  configPath: string;
  digest: string;
  basis: OwnershipBasis;
  updatedAt: string;
};

/** A file sync-agents generated in an agent's directory (a command or an agent definition). */
export type ManagedFileRecord = {
  kind: "command" | "agent";
  /** sha256 of the bytes written. */
  digest: string;
  basis: OwnershipBasis;
  updatedAt: string;
};

export type OwnershipStateV2 = {
  version: 2;
  generation: number;
  hubPath: string;
  links: Record<string, ManagedLinkRecord>;
  /** Generated files, keyed by destination (absent in ledgers written before Phase 7). */
  files: Record<string, ManagedFileRecord>;
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
  | { kind: "link-delete"; destination: string }
  | { kind: "file-set"; destination: string; record: ManagedFileRecord }
  | { kind: "file-delete"; destination: string };

export type JournalOpKind =
  | "mcp-write"
  | "link-create"
  | "link-replace"
  | "link-adopt-copy"
  | "link-prune"
  | "skill-replace"
  | "file-write"
  | "file-delete";

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
  domain: "skill" | "link" | "mcp" | "rules" | "recovery";
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
  targets?: TargetSelector[];
  disownLegacy?: Array<{ agent: AgentId; name: string }>;
  /** Called with each output event as it happens (the CLI prints it at once). */
  onEvent?: (event: import("./output.ts").OutputEvent) => void;
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
  /** Human messages, in order (what --human prints). */
  stdout: string[];
  stderr: string[];
  /** Structured events, one per printed line (what the default JSON Lines output prints). */
  events: import("./output.ts").OutputEvent[];
  recovery?: RecoveryReport;
};

/**
 * One entry of `--targets` or `disabledTargets`: a whole target (`"opencode"`) or one of its
 * two sync domains (`"opencode:mcp"` for the MCP config, `"opencode:links"` for the rules and
 * skill symlinks).
 */
export type TargetDomain = "links" | "mcp";
export type TargetSelector = { agent: AgentId; domains: readonly TargetDomain[] };

/** Which targets each domain acts on in one run. */
export type TargetScope = { links: ReadonlySet<AgentId>; mcp: ReadonlySet<AgentId> };

const DOMAINS: readonly TargetDomain[] = ["links", "mcp"];

export function targetSelectorNames(): string {
  return `${ALL_AGENTS.join(", ")}, optionally suffixed with :mcp or :links`;
}

/** Parse `claude`, `claude:mcp` or `claude:links`; returns null for anything else. */
export function parseTargetSelector(raw: string): TargetSelector | null {
  const [name, domain, extra] = raw.split(":");
  if (extra !== undefined || !ALL_AGENTS.includes(name as AgentId)) return null;
  if (domain === undefined) return { agent: name as AgentId, domains: DOMAINS };
  if (!DOMAINS.includes(domain as TargetDomain)) return null;
  return { agent: name as AgentId, domains: [domain as TargetDomain] };
}

/**
 * Resolve the run's scope. An explicit `--targets` list replaces `disabledTargets`: it names
 * exactly what to act on. Otherwise everything is active except what `disabledTargets` removes.
 */
export function resolveTargetScope(
  explicit: readonly TargetSelector[] | undefined,
  disabled: readonly TargetSelector[],
): TargetScope {
  const links = new Set<AgentId>();
  const mcp = new Set<AgentId>();
  const sets = { links, mcp };
  if (explicit && explicit.length > 0) {
    for (const sel of explicit) for (const d of sel.domains) sets[d].add(sel.agent);
  } else {
    for (const a of ALL_AGENTS) {
      links.add(a);
      mcp.add(a);
    }
    for (const sel of disabled) for (const d of sel.domains) sets[d].delete(sel.agent);
  }
  return { links, mcp };
}
