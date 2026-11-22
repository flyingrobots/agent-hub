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
import {
  captureSymlinkOrAbsentSnapshot,
  captureTreeSnapshot,
  checkAdoptionEquivalence,
  fsyncDir,
  snapshotsEqual,
} from "./paths.ts";
import {
  applyStateDelta,
  clearJournal,
  saveOwnershipState,
  writeJournal,
} from "./state.ts";
import type {
  ApplyHooks,
  ManagedLinkRecord,
  OwnershipBasis,
  OwnershipStateV2,
  PendingJournalRecord,
  PlannedOp,
  TargetSnapshot,
} from "./types.ts";

export const LINK_TARGETS = [
  { rootRel: ".codex", rulesRel: "AGENTS.md", skillsRel: "skills" },
  { rootRel: ".claude", rulesRel: "CLAUDE.md", skillsRel: "skills" },
  { rootRel: ".gemini", rulesRel: "GEMINI.md", skillsRel: "skills" },
  { rootRel: ".gemini/config", rulesRel: "AGENTS.md", skillsRel: null },
  { rootRel: ".config/opencode", rulesRel: "AGENTS.md", skillsRel: "skills" },
  { rootRel: ".cursor", rulesRel: "AGENTS.md", skillsRel: "skills" },
] as const;

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

function predictNewEntryOwner(parentDir: string): { uid: number; gid: number } {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const procGid = typeof process.getgid === "function" ? process.getgid() : 0;
  try {
    let cursor = parentDir;
    while (!existsSync(cursor)) {
      const next = dirname(cursor);
      if (next === cursor) return { uid, gid: procGid };
      cursor = next;
    }
    const st = statSync(cursor);
    if (process.platform === "darwin" || (st.mode & 0o2000) !== 0) {
      return { uid, gid: st.gid };
    }
  } catch {
    // fallback to process gid
  }
  return { uid, gid: procGid };
}

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

export function planLinkSync(
  canonicalHubPath: string,
  homeDir: string,
  state: OwnershipStateV2,
  plannedSkillNames: string[],
  opts: { adopt: boolean; force: boolean },
): PlannedLinkOp[] {
  const plans: PlannedLinkOp[] = [];
  const canonicalRules = join(canonicalHubPath, "AGENTS.md");
  const canonicalSkills = join(canonicalHubPath, "skills");
  const hasRules = existsSync(canonicalRules) && statSync(canonicalRules).isFile();
  const skillNames = collectCanonicalSkillNames(canonicalHubPath, plannedSkillNames);
  const hasSkillsDir =
    (existsSync(canonicalSkills) && statSync(canonicalSkills).isDirectory()) ||
    plannedSkillNames.length > 0;

  const desired = new Map<string, { src: string; kind: "rules" | "skill" }>();

  for (const target of LINK_TARGETS) {
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
        });
      }
    }
  }

  for (const dst of [...desired.keys()].sort()) {
    const { src, kind } = desired.get(dst)!;
    const managedRec = state.links[dst];

    let lst = null;
    try {
      lst = lstatSync(dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }

    // T-LNK-01: Destination does not exist
    if (!lst) {
      plans.push({
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
      });
      continue;
    }

    // Destination is a symlink
    if (lst.isSymbolicLink()) {
      const currentTarget = readlinkSync(dst);
      const validRef = isValidReferent(dst, kind);
      const beforeSnap = captureSymlinkOrAbsentSnapshot(dst);

      if (managedRec) {
        if (currentTarget === managedRec.target) {
          if (currentTarget === src && validRef) {
            // T-LNK-02: In sync, zero churn
            plans.push({
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
            });
            continue;
          }

          // Managed symlink still matches recorded target, but canonical path changed or referent is broken
          plans.push({
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
          });
          continue;
        }

        // T-LNK-03: Managed symlink was externally repointed!
        if (opts.force) {
          plans.push({
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
          });
        } else {
          plans.push({
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
          });
        }
        continue;
      }

      // Unmanaged symlink (not in state.links)
      if (currentTarget === src && validRef) {
        // T-LNK-04: Unmanaged identical symlink -> ledger-only adoption
        if (opts.adopt || opts.force) {
          plans.push({
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
          });
        } else {
          plans.push({
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
          });
        }
        continue;
      }

      // T-LNK-05: Unmanaged differing or broken symlink
      if (opts.force) {
        plans.push({
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
        });
      } else {
        plans.push({
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
        });
      }
      continue;
    }

    // T-LNK-06 / T-LNK-07: Non-symlink real file or directory
    const eqResult = existsSync(src)
      ? checkAdoptionEquivalence(src, dst)
      : ({ equivalent: false, reason: "canonical source does not exist on disk yet" } as const);

    if (eqResult.equivalent) {
      if (opts.adopt) {
        plans.push({
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
        });
      } else {
        plans.push({
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
        });
      }
    } else {
      // T-LNK-07: Fails adoption-equivalence contract — refused even under --adopt and --force!
      plans.push({
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
      });
    }
  }

  // Pruning: iterate ONLY over verified v2 state.links records (never scan skills/ by prefix!).
  for (const dst of Object.keys(state.links).sort()) {
    if (desired.has(dst)) continue;
    const rec = state.links[dst]!;

    let lst = null;
    try {
      lst = lstatSync(dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }

    // T-LNK-09: Managed symlink already absent -> ledger-only cleanup
    if (!lst) {
      plans.push({
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
      });
      continue;
    }

    // T-LNK-08: Still our exact managed symlink -> safe to prune
    if (lst.isSymbolicLink() && readlinkSync(dst) === rec.target) {
      const beforeSnap = captureSymlinkOrAbsentSnapshot(dst);
      plans.push({
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
      });
      continue;
    }

    // T-LNK-10: User replaced destination with different symlink or real file/dir -> preserve!
    const observedDesc = lst.isSymbolicLink()
      ? `symlink -> ${readlinkSync(dst)} (expected ${rec.target})`
      : "non-symlink file/directory";
    plans.push({
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
    });
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

  // Target-mutating link operations follow the 4-step write-ahead journal protocol.
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
    // Commitment point: once rename(dst, backupPath) succeeds, the switch to tracking
    // the canonical source is committed, and Phase 0 recovery completes it.
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

  // link-create or link-replace
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
