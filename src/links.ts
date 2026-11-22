import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LINK_TARGETS, resolveLinkTargetId } from "./adapters.ts";
import {
  captureSymlinkOrAbsentSnapshot,
  captureTreeSnapshot,
  checkAdoptionEquivalence,
  fsyncDir,
  predictNewEntryOwner,
  snapshotsEqual,
} from "./paths.ts";
import {
  applyStateDelta,
  clearJournal,
  saveOwnershipState,
  writeJournal,
} from "./state.ts";
import type {
  AgentId,
  ApplyHooks,
  ManagedLinkRecord,
  OwnershipBasis,
  OwnershipStateV2,
  PendingJournalRecord,
  PlannedOp,
  TargetSnapshot,
} from "./types.ts";

export { LINK_TARGETS };

export type LinkActionKind =
  | "keep"
  | "link-create"
  | "link-replace"
  | "link-adopt-copy"
  | "adopt-symlink"
  | "link-prune"
  | "drop-absent-link"
  | "conflict";

export type PlannedLinkOp = {
  op: PlannedOp;
  actionKind: LinkActionKind;
  linkKind: "rules" | "skill";
  src?: string;
  dst: string;
  basis?: OwnershipBasis;
  beforeSnapshot: TargetSnapshot;
  srcSnapshot?: Extract<TargetSnapshot, { kind: "tree" }>;
};

function isValidReferent(dst: string, kind: "rules" | "skill"): boolean {
  try {
    const st = statSync(dst);
    if (kind === "rules") return st.isFile();
    if (!st.isDirectory()) return false;
    const skillMd = join(dst, "SKILL.md");
    return existsSync(skillMd) && statSync(skillMd).isFile();
  } catch {
    return false;
  }
}

export function collectCanonicalSkillNames(
  canonicalHubPath: string,
  plannedSkillNames: string[],
): string[] {
  const names = new Set<string>();
  const skillsRoot = join(canonicalHubPath, "skills");
  if (existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()) {
    for (const entry of readdirSync(skillsRoot)) {
      if (entry.startsWith(".")) continue;
      const full = join(skillsRoot, entry);
      try {
        if (
          statSync(full).isDirectory() &&
          existsSync(join(full, "SKILL.md")) &&
          statSync(join(full, "SKILL.md")).isFile()
        ) {
          names.add(entry);
        }
      } catch {
        // skip unreadable or broken entries
      }
    }
  }
  for (const planned of plannedSkillNames) names.add(planned);
  return [...names].sort();
}

function planDesiredLinkOp(
  dst: string,
  src: string,
  kind: "rules" | "skill",
  stagedSrcDir: string | undefined,
  managedRec: ManagedLinkRecord | undefined,
  opts: { adopt: boolean; force: boolean },
): PlannedLinkOp {
  let lst = null;
  try {
    lst = lstatSync(dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  // T-LNK-01: Destination does not exist
  if (!lst) {
    return {
      actionKind: "link-create",
      linkKind: kind,
      src,
      dst,
      basis: "created",
      beforeSnapshot: { kind: "absent" },
      op: {
        domain: "link",
        action: "link-create",
        status: "change",
        destination: dst,
        observed: "absent",
        intended: `symlink -> ${src}`,
        ownershipBasis: "created",
        reason: managedRec
          ? "previously managed symlink is missing; recreating"
          : "destination is absent; creating new managed symlink",
        targetMutation: true,
        ledgerMutation: true,
      },
    };
  }

  // Existing symlink
  if (lst.isSymbolicLink()) {
    const currentTarget = readlinkSync(dst);
    const validRef = isValidReferent(dst, kind);
    const beforeSnap = captureSymlinkOrAbsentSnapshot(dst);

    if (managedRec) {
      if (currentTarget === managedRec.target) {
        if (currentTarget === src && validRef) {
          return {
            actionKind: "keep",
            linkKind: kind,
            src,
            dst,
            beforeSnapshot: beforeSnap,
            op: {
              domain: "link",
              action: "keep",
              status: "ok",
              destination: dst,
              observed: `symlink -> ${currentTarget} (valid ${kind})`,
              intended: `symlink -> ${src}`,
              ownershipBasis: managedRec.basis,
              reason: "managed symlink matches canonical target and referent is valid",
              targetMutation: false,
              ledgerMutation: false,
            },
          };
        }

        return {
          actionKind: "link-replace",
          linkKind: kind,
          src,
          dst,
          basis: managedRec.basis,
          beforeSnapshot: beforeSnap,
          op: {
            domain: "link",
            action: "link-replace",
            status: "change",
            destination: dst,
            observed: `managed symlink -> ${currentTarget}${validRef ? "" : " (broken referent)"}`,
            intended: `symlink -> ${src}`,
            ownershipBasis: managedRec.basis,
            reason: validRef
              ? "managed symlink target updated"
              : "managed symlink referent is broken or wrong kind",
            targetMutation: true,
            ledgerMutation: true,
          },
        };
      }

      if (opts.force) {
        return {
          actionKind: "link-replace",
          linkKind: kind,
          src,
          dst,
          basis: "forced",
          beforeSnapshot: beforeSnap,
          op: {
            domain: "link",
            action: "link-replace",
            status: "change",
            destination: dst,
            observed: `managed symlink externally repointed to ${currentTarget} (expected ${managedRec.target})`,
            intended: `symlink -> ${src}`,
            ownershipBasis: "forced",
            reason: "explicit --force authorized replacing externally modified symlink",
            targetMutation: true,
            ledgerMutation: true,
          },
        };
      }

      return {
        actionKind: "conflict",
        linkKind: kind,
        src,
        dst,
        beforeSnapshot: beforeSnap,
        op: {
          domain: "link",
          action: "conflict",
          status: "conflict",
          destination: dst,
          observed: `symlink -> ${currentTarget} (ledger expected -> ${managedRec.target})`,
          intended: `symlink -> ${src}`,
          ownershipBasis: "managed-externally-modified",
          reason: `managed symlink ${dst} was externally repointed to ${currentTarget}`,
          nextStep: "Inspect target or re-run with --force to replace",
          targetMutation: false,
          ledgerMutation: false,
        },
      };
    }

    // Unmanaged symlink
    if (currentTarget === src && validRef) {
      if (opts.adopt || opts.force) {
        return {
          actionKind: "adopt-symlink",
          linkKind: kind,
          src,
          dst,
          basis: "adopted",
          beforeSnapshot: beforeSnap,
          op: {
            domain: "link",
            action: "adopt-symlink",
            status: "change",
            destination: dst,
            observed: `unmanaged symlink -> ${currentTarget} (valid ${kind})`,
            intended: `record ownership in ledger for ${dst} -> ${src}`,
            ownershipBasis: "adopted",
            reason: "unmanaged symlink already matches canonical target; recording ownership",
            targetMutation: false,
            ledgerMutation: true,
          },
        };
      }

      return {
        actionKind: "conflict",
        linkKind: kind,
        src,
        dst,
        beforeSnapshot: beforeSnap,
        op: {
          domain: "link",
          action: "conflict",
          status: "conflict",
          destination: dst,
          observed: `unmanaged symlink -> ${currentTarget} (valid ${kind})`,
          intended: `managed symlink -> ${src}`,
          ownershipBasis: "unmanaged",
          reason: `${dst} is an unmanaged symlink pointing to ${src}`,
          nextStep: "Re-run with --adopt to record verified ownership without modifying the link",
          targetMutation: false,
          ledgerMutation: false,
        },
      };
    }

    if (opts.force) {
      return {
        actionKind: "link-replace",
        linkKind: kind,
        src,
        dst,
        basis: "forced",
        beforeSnapshot: beforeSnap,
        op: {
          domain: "link",
          action: "link-replace",
          status: "change",
          destination: dst,
          observed: `unmanaged symlink -> ${currentTarget}${validRef ? "" : " (broken)"}`,
          intended: `symlink -> ${src}`,
          ownershipBasis: "forced",
          reason: "explicit --force authorized replacing unmanaged symlink",
          targetMutation: true,
          ledgerMutation: true,
        },
      };
    }

    return {
      actionKind: "conflict",
      linkKind: kind,
      src,
      dst,
      beforeSnapshot: beforeSnap,
      op: {
        domain: "link",
        action: "conflict",
        status: "conflict",
        destination: dst,
        observed: `unmanaged symlink -> ${currentTarget}${validRef ? "" : " (broken)"}`,
        intended: `symlink -> ${src}`,
        ownershipBasis: "unmanaged",
        reason: validRef
          ? `${dst} is an unmanaged symlink pointing to ${currentTarget}`
          : `${dst} is an unmanaged broken symlink pointing to ${currentTarget}`,
        nextStep: "Inspect or remove it manually, or re-run with --force to replace",
        targetMutation: false,
        ledgerMutation: false,
      },
    };
  }

  // Non-symlink real file or directory.
  // Support single-pass `--adopt --skill <src>`: when canonical `src` does not exist on disk yet
  // but is being installed from `stagedSrcDir` in Phase 2, evaluate equivalence against the exact
  // tree that `applySkillInstall` will place at `src` (excluding root .git, root mode 0755).
  const eqResult = existsSync(src)
    ? checkAdoptionEquivalence(src, dst)
    : stagedSrcDir && existsSync(stagedSrcDir)
      ? checkAdoptionEquivalence(stagedSrcDir, dst, {
          excludeRootGit: true,
          forceRootDirMode: 0o755,
        })
      : ({ equivalent: false, reason: "canonical source does not exist on disk yet" } as const);

  if (eqResult.equivalent) {
    if (opts.adopt) {
      return {
        actionKind: "link-adopt-copy",
        linkKind: kind,
        src,
        dst,
        basis: "adopted",
        beforeSnapshot: eqResult.dstSnapshot,
        srcSnapshot: eqResult.srcSnapshot,
        op: {
          domain: "link",
          action: "link-adopt-copy",
          status: "change",
          destination: dst,
          observed: `unmanaged ${eqResult.dstSnapshot.rootKind} passing full adoption-equivalence contract`,
          intended: `replace with managed symlink -> ${src}`,
          ownershipBasis: "adopted",
          reason: "explicit --adopt authorized replacing verified-equivalent copy with symlink",
          targetMutation: true,
          ledgerMutation: true,
        },
      };
    }

    return {
      actionKind: "conflict",
      linkKind: kind,
      src,
      dst,
      beforeSnapshot: eqResult.dstSnapshot,
      op: {
        domain: "link",
        action: "conflict",
        status: "conflict",
        destination: dst,
        observed: `unmanaged ${eqResult.dstSnapshot.rootKind} (equivalent to canonical ${src})`,
        intended: `managed symlink -> ${src}`,
        ownershipBasis: "unmanaged",
        reason: `${dst} exists and is not a symlink (verified equivalent to ${src})`,
        nextStep: "Re-run with --adopt to replace with a managed symlink",
        targetMutation: false,
        ledgerMutation: false,
      },
    };
  }

  return {
    actionKind: "conflict",
    linkKind: kind,
    src,
    dst,
    beforeSnapshot: { kind: "absent" },
    op: {
      domain: "link",
      action: "conflict",
      status: "conflict",
      destination: dst,
      observed: `unmanaged non-symlink (${eqResult.reason})`,
      intended: `symlink -> ${src}`,
      ownershipBasis: "unmanaged",
      reason: `${dst} exists and is not equivalent to ${src}: ${eqResult.reason}`,
      nextStep: "Inspect and merge or move manually; adoption refuses non-equivalent files/directories",
      targetMutation: false,
      ledgerMutation: false,
    },
  };
}

function planPruneLinkOp(dst: string, rec: ManagedLinkRecord): PlannedLinkOp {
  let lst = null;
  try {
    lst = lstatSync(dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  if (!lst) {
    return {
      actionKind: "drop-absent-link",
      linkKind: rec.kind,
      dst,
      beforeSnapshot: { kind: "absent" },
      op: {
        domain: "link",
        action: "drop-absent-link",
        status: "change",
        destination: dst,
        observed: "absent (stale ownership record in ledger)",
        intended: "remove absent link record from ownership ledger",
        ownershipBasis: rec.basis,
        reason: "canonical source and destination symlink are both absent",
        targetMutation: false,
        ledgerMutation: true,
      },
    };
  }

  if (lst.isSymbolicLink() && readlinkSync(dst) === rec.target) {
    const beforeSnap = captureSymlinkOrAbsentSnapshot(dst);
    return {
      actionKind: "link-prune",
      linkKind: rec.kind,
      dst,
      basis: rec.basis,
      beforeSnapshot: beforeSnap,
      op: {
        domain: "link",
        action: "link-prune",
        status: "change",
        destination: dst,
        observed: `managed symlink -> ${rec.target}`,
        intended: "remove stale managed symlink",
        ownershipBasis: rec.basis,
        reason: "canonical source was removed and destination matches recorded managed target",
        targetMutation: true,
        ledgerMutation: true,
      },
    };
  }

  const observedDesc = lst.isSymbolicLink()
    ? `symlink -> ${readlinkSync(dst)} (expected ${rec.target})`
    : "non-symlink file/directory";
  return {
    actionKind: "conflict",
    linkKind: rec.kind,
    dst,
    beforeSnapshot: { kind: "absent" },
    op: {
      domain: "link",
      action: "conflict",
      status: "conflict",
      destination: dst,
      observed: observedDesc,
      intended: "prune removed managed symlink",
      ownershipBasis: "managed-externally-modified",
      reason: `refusing to prune ${dst}: destination no longer matches recorded managed symlink (${rec.target})`,
      nextStep: "Inspect destination and remove it manually if no longer needed",
      targetMutation: false,
      ledgerMutation: false,
    },
  };
}

export function planLinkSync(
  canonicalHubPath: string,
  homeDir: string,
  state: OwnershipStateV2,
  plannedSkillNames: string[],
  opts: {
    adopt: boolean;
    force: boolean;
    activeTargets?: ReadonlySet<AgentId>;
    plannedSkillSources?: Map<string, string>;
  },
): PlannedLinkOp[] {
  const plans: PlannedLinkOp[] = [];
  const canonicalRules = join(canonicalHubPath, "AGENTS.md");
  const canonicalSkills = join(canonicalHubPath, "skills");
  const hasRules = existsSync(canonicalRules) && statSync(canonicalRules).isFile();
  const skillNames = collectCanonicalSkillNames(canonicalHubPath, plannedSkillNames);
  const hasSkillsDir =
    (existsSync(canonicalSkills) && statSync(canonicalSkills).isDirectory()) ||
    plannedSkillNames.length > 0;

  const desired = new Map<string, { src: string; kind: "rules" | "skill"; skillName?: string }>();

  for (const target of LINK_TARGETS) {
    if (opts.activeTargets && !opts.activeTargets.has(target.targetId)) continue;
    const rootDir = join(homeDir, target.rootRel);
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) continue;

    if (target.rulesRel && hasRules) {
      desired.set(join(rootDir, target.rulesRel), {
        src: canonicalRules,
        kind: "rules",
      });
    }
    if (target.skillsRel && hasSkillsDir) {
      for (const skillName of skillNames) {
        desired.set(join(rootDir, target.skillsRel, skillName), {
          src: join(canonicalSkills, skillName),
          kind: "skill",
          skillName,
        });
      }
    }
  }

  for (const dst of [...desired.keys()].sort()) {
    const entry = desired.get(dst)!;
    const stagedSrcDir =
      entry.skillName !== undefined ? opts.plannedSkillSources?.get(entry.skillName) : undefined;
    plans.push(
      planDesiredLinkOp(dst, entry.src, entry.kind, stagedSrcDir, state.links[dst], opts),
    );
  }

  // Prune ONLY verified v2 state.links records for ACTIVE targets.
  // Untargeted adapters are never pruned!
  for (const dst of Object.keys(state.links).sort()) {
    if (desired.has(dst)) continue;
    if (opts.activeTargets) {
      const ownerTarget = resolveLinkTargetId(dst, homeDir);
      if (ownerTarget !== null && !opts.activeTargets.has(ownerTarget)) continue;
    }
    plans.push(planPruneLinkOp(dst, state.links[dst]!));
  }

  return plans;
}

function atomicCreateOrReplaceSymlink(src: string, dst: string): void {
  const dir = dirname(dst);
  mkdirSync(dir, { recursive: true });
  const tmpLink = join(
    dir,
    `.sync-agents-link-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  symlinkSync(src, tmpLink);
  try {
    renameSync(tmpLink, dst);
    fsyncDir(dir);
  } catch (err) {
    try {
      unlinkSync(tmpLink);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function applyLinkOp(
  plan: PlannedLinkOp,
  canonicalHubPath: string,
  state: OwnershipStateV2,
  statePath: string,
  journalPath: string,
  flags: { adopt: boolean; force: boolean; forceSkill: boolean },
  hooks?: ApplyHooks,
): OwnershipStateV2 {
  if (plan.op.status !== "change") return state;

  const now = new Date().toISOString();

  // Direct state-commit path for ledger-only operations (no target-write journal).
  if (plan.actionKind === "adopt-symlink") {
    const live = captureSymlinkOrAbsentSnapshot(plan.dst);
    if (!snapshotsEqual(live, plan.beforeSnapshot)) {
      throw new Error(
        `stale snapshot: ${plan.dst} changed after planning; refusing ledger adoption`,
      );
    }
    const rec: ManagedLinkRecord = {
      kind: plan.linkKind,
      target: plan.src!,
      basis: "adopted",
      updatedAt: now,
    };
    hooks?.beforeLedgerOnlyCommit?.(`adopt-symlink ${plan.dst}`);
    const nextState = applyStateDelta(state, {
      kind: "link-set",
      destination: plan.dst,
      record: rec,
    });
    saveOwnershipState(statePath, nextState);
    return nextState;
  }

  if (plan.actionKind === "drop-absent-link") {
    const live = captureSymlinkOrAbsentSnapshot(plan.dst);
    if (!snapshotsEqual(live, plan.beforeSnapshot)) {
      throw new Error(
        `stale snapshot: ${plan.dst} appeared after planning; refusing ledger cleanup`,
      );
    }
    hooks?.beforeLedgerOnlyCommit?.(`drop-absent-link ${plan.dst}`);
    const nextState = applyStateDelta(state, {
      kind: "link-delete",
      destination: plan.dst,
    });
    saveOwnershipState(statePath, nextState);
    return nextState;
  }

  const opId = `link-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const parentDir = dirname(plan.dst);
  const owner = predictNewEntryOwner(parentDir);

  if (plan.actionKind === "link-prune") {
    const journal: PendingJournalRecord = {
      version: 1,
      opId,
      hubPath: canonicalHubPath,
      expectedStateGeneration: state.generation,
      targetStateGeneration: state.generation + 1,
      kind: "link-prune",
      authorization: {
        flags,
        basis: plan.basis ?? "managed",
        reason: plan.op.reason,
      },
      destination: plan.dst,
      before: plan.beforeSnapshot,
      after: { kind: "absent" },
      stateDelta: { kind: "link-delete", destination: plan.dst },
    };

    writeJournal(journalPath, journal);
    hooks?.beforeTargetMutate?.(journal);

    const live = captureSymlinkOrAbsentSnapshot(plan.dst);
    if (!snapshotsEqual(live, plan.beforeSnapshot)) {
      clearJournal(journalPath);
      throw new Error(
        `stale snapshot: ${plan.dst} changed after planning; preserving destination`,
      );
    }

    unlinkSync(plan.dst);
    fsyncDir(parentDir);
    hooks?.afterTargetMutate?.(journal);

    const nextState = applyStateDelta(state, journal.stateDelta);
    saveOwnershipState(statePath, nextState);
    hooks?.afterStateCommit?.(journal);
    clearJournal(journalPath);
    return nextState;
  }

  const newRecord: ManagedLinkRecord = {
    kind: plan.linkKind,
    target: plan.src!,
    basis: plan.basis ?? "created",
    updatedAt: now,
  };
  const afterSnapshot: TargetSnapshot = {
    kind: "symlink",
    target: plan.src!,
    uid: owner.uid,
    gid: owner.gid,
  };

  if (plan.actionKind === "link-adopt-copy") {
    const backupPath = join(parentDir, `.agent-hub-adopt-${opId}`);
    const journal: PendingJournalRecord = {
      version: 1,
      opId,
      hubPath: canonicalHubPath,
      expectedStateGeneration: state.generation,
      targetStateGeneration: state.generation + 1,
      kind: "link-adopt-copy",
      authorization: {
        flags,
        basis: "adopted",
        reason: plan.op.reason,
      },
      destination: plan.dst,
      before: plan.beforeSnapshot,
      after: afterSnapshot,
      backupPath,
      sourcePath: plan.src,
      stateDelta: { kind: "link-set", destination: plan.dst, record: newRecord },
    };

    writeJournal(journalPath, journal);
    hooks?.beforeTargetMutate?.(journal);

    // Revalidate EVERY adoption-equivalence property on BOTH dst and src strictly before mutation!
    const liveDst = captureTreeSnapshot(plan.dst);
    const liveSrc = captureTreeSnapshot(plan.src!);
    if (
      !snapshotsEqual(liveDst, plan.beforeSnapshot) ||
      !plan.srcSnapshot ||
      !snapshotsEqual(liveSrc, plan.srcSnapshot)
    ) {
      clearJournal(journalPath);
      throw new Error(
        `stale snapshot: source or destination changed after adoption-equivalence check for ${plan.dst}; preserving destination`,
      );
    }

    renameSync(plan.dst, backupPath);
    fsyncDir(parentDir);
    hooks?.afterBackupRename?.(journal);

    symlinkSync(plan.src!, plan.dst);
    fsyncDir(parentDir);
    hooks?.afterTargetMutate?.(journal);

    const nextState = applyStateDelta(state, journal.stateDelta);
    saveOwnershipState(statePath, nextState);
    hooks?.afterStateCommit?.(journal);

    rmSync(backupPath, { recursive: true, force: true });
    fsyncDir(parentDir);
    clearJournal(journalPath);
    return nextState;
  }

  const journal: PendingJournalRecord = {
    version: 1,
    opId,
    hubPath: canonicalHubPath,
    expectedStateGeneration: state.generation,
    targetStateGeneration: state.generation + 1,
    kind: plan.actionKind === "link-create" ? "link-create" : "link-replace",
    authorization: {
      flags,
      basis: plan.basis ?? "created",
      reason: plan.op.reason,
    },
    destination: plan.dst,
    before: plan.beforeSnapshot,
    after: afterSnapshot,
    stateDelta: { kind: "link-set", destination: plan.dst, record: newRecord },
  };

  writeJournal(journalPath, journal);
  hooks?.beforeTargetMutate?.(journal);

  const live = captureSymlinkOrAbsentSnapshot(plan.dst);
  if (!snapshotsEqual(live, plan.beforeSnapshot)) {
    clearJournal(journalPath);
    throw new Error(
      `stale snapshot: ${plan.dst} changed after planning; preserving destination`,
    );
  }

  atomicCreateOrReplaceSymlink(plan.src!, plan.dst);
  hooks?.afterTargetMutate?.(journal);

  const nextState = applyStateDelta(state, journal.stateDelta);
  saveOwnershipState(statePath, nextState);
  hooks?.afterStateCommit?.(journal);
  clearJournal(journalPath);
  return nextState;
}
