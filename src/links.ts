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
import { LINK_TARGETS, linkTargetRoot, resolveLinkTargetId } from "./adapters.ts";
import {
  physicalPath,
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
import { ALL_AGENTS } from "./types.ts";
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
  | "drop-duplicate-record"
  | "rekey-link-record"
  | "conflict";

export type PlannedLinkOp = {
  op: PlannedOp;
  actionKind: LinkActionKind;
  linkKind: "rules" | "skill";
  src?: string;
  dst: string;
  /** rekey-link-record: the spelling the record is stored under now. */
  fromDst?: string;
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
        reason: "no longer a desired link (its canonical source was removed, or its target root moved) and destination matches recorded managed target",
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
    /** XDG config base (`$XDG_CONFIG_HOME` or `~/.config`); defaults to `~/.config`. */
    configBase?: string;
  },
): PlannedLinkOp[] {
  const configBase = opts.configBase ?? join(homeDir, ".config");
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
    const rootDir = linkTargetRoot(target, homeDir, configBase);
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

  // Ownership is decided by physical path: when a desired destination is already recorded under
  // another spelling of the same location (a symlinked ~/.config, an aliased HOME), plan against
  // the recorded spelling, so it is neither duplicated, nor reported as an unmanaged conflict,
  // nor pruned as stale.
  // Group records by physical path. Two spellings of one destination (left by an older version
  // run under an aliased HOME) keep one record, preferring the spelling desired now; the others
  // are retired ledger-only, so the same symlink is never pruned twice.
  const desiredSpellings = new Set(desired.keys());
  // One order decides which spelling of a physical link holds its record, here and in the
  // planner below: a spelling desired now, then the one whose path goes through the fewest
  // symlinked directories (splitting a shared directory replaces the symlinked side, so the real
  // side keeps the link), then one already recorded, then by name.
  // Symlinked directories along a spelling's parent path. Counted, not tested for zero, so a
  // HOME that is itself reached through an alias still tells the shared directory's sides apart.
  const symlinkCache = new Map<string, number>();
  const symlinksIn = (p: string): number => {
    const parent = dirname(p);
    const hit = symlinkCache.get(parent);
    if (hit !== undefined) return hit;
    let n = 0;
    let cur = parent;
    while (cur !== dirname(cur)) {
      try {
        if (lstatSync(cur).isSymbolicLink()) n += 1;
      } catch {
        // a missing component is not a symlink
      }
      cur = dirname(cur);
    }
    symlinkCache.set(parent, n);
    return n;
  };
  const preferSpelling = (a: string, b: string) =>
    Number(!desiredSpellings.has(a)) - Number(!desiredSpellings.has(b)) ||
    symlinksIn(a) - symlinksIn(b) ||
    Number(!state.links[a]) - Number(!state.links[b]) ||
    (a < b ? -1 : a > b ? 1 : 0);
  const byPhysical = new Map<string, string[]>();
  for (const key of Object.keys(state.links).sort()) {
    const phys = physicalPath(key);
    byPhysical.set(phys, [...(byPhysical.get(phys) ?? []), key]);
  }
  const recordedByPhysical = new Map<string, string>();
  const duplicateKeys = new Set<string>();
  for (const [phys, keys] of byPhysical) {
    const primary = [...keys].sort(preferSpelling)[0]!;
    recordedByPhysical.set(phys, primary);
    for (const k of keys) if (k !== primary) duplicateKeys.add(k);
  }
  const scoped = opts.activeTargets !== undefined && opts.activeTargets.size < ALL_AGENTS.length;
  for (const dup of [...duplicateKeys].sort()) {
    // A scoped run only retires duplicates it can attribute to an active target; the others are
    // kept untouched (and are skipped by the prune loop below), like any excluded target's record.
    if (scoped) {
      const primary = recordedByPhysical.get(physicalPath(dup))!;
      const owner =
        resolveLinkTargetId(primary, homeDir, configBase) ?? resolveLinkTargetId(dup, homeDir, configBase);
      if (owner === null || !opts.activeTargets!.has(owner)) continue;
    }
    const rec = state.links[dup]!;
    plans.push({
      actionKind: "drop-duplicate-record",
      linkKind: rec.kind,
      dst: dup,
      beforeSnapshot: { kind: "absent" },
      op: {
        domain: "link",
        action: "drop-duplicate-record",
        status: "change",
        destination: dup,
        observed: `second ownership record for ${recordedByPhysical.get(physicalPath(dup))} under another spelling`,
        intended: "remove the duplicate record from the ownership ledger; the link itself is unchanged",
        ownershipBasis: rec.basis,
        reason: "two ledger records name the same physical destination",
        targetMutation: false,
        ledgerMutation: true,
      },
    });
  }
  const desiredPhysical = new Set<string>();
  // Two desired spellings can name one physical link (~/.codex/skills a symlink to
  // ~/.claude/skills). It is one object: plan it once, under the spelling that holds its record,
  // or else the first in order.
  const plannedPhysical = new Set<string>();
  const physicalOrder = [...desired.keys()].sort(preferSpelling);
  for (const dst of physicalOrder) {
    const entry = desired.get(dst)!;
    const phys = physicalPath(dst);
    desiredPhysical.add(phys);
    if (plannedPhysical.has(phys)) continue;
    plannedPhysical.add(phys);
    const recordedKey = state.links[dst] ? dst : (recordedByPhysical.get(phys) ?? dst);
    const stagedSrcDir =
      entry.skillName !== undefined ? opts.plannedSkillSources?.get(entry.skillName) : undefined;
    // Re-key only a record that names this destination for the same target under a spelling no
    // longer desired. A record held by another desired spelling, or attributed to another target
    // (an excluded one included), stays where it is.
    if (recordedKey !== dst) {
      const recordedOwner = resolveLinkTargetId(recordedKey, homeDir, configBase);
      const dstOwner = resolveLinkTargetId(dst, homeDir, configBase);
      // Another desired spelling of the same link: move the record here only when this one is the
      // physical spelling and that one is not (both targets are in this run).
      const intoPhysical = desired.has(recordedKey) && symlinksIn(dst) < symlinksIn(recordedKey);
      if (!intoPhysical && (desired.has(recordedKey) || (recordedOwner !== null && recordedOwner !== dstOwner))) {
        plans.push(planDesiredLinkOp(recordedKey, entry.src, entry.kind, stagedSrcDir, state.links[recordedKey], opts));
        continue;
      }
    }
    if (recordedKey !== dst) {
      // The record names this destination under another spelling. Move it to the spelling that
      // resolves now (ledger only), so it still matches after the old spelling stops resolving.
      const rec = state.links[recordedKey]!;
      plans.push({
        actionKind: "rekey-link-record",
        linkKind: rec.kind,
        dst,
        fromDst: recordedKey,
        beforeSnapshot: { kind: "absent" },
        op: {
          domain: "link",
          action: "rekey-link-record",
          status: "change",
          destination: dst,
          observed: `ownership record for this link stored under another spelling, ${recordedKey}`,
          intended: "store the record under the spelling used now; the link itself is unchanged",
          ownershipBasis: rec.basis,
          reason: "the recorded spelling names the same physical destination as the current one",
          targetMutation: false,
          ledgerMutation: true,
        },
      });
    }
    plans.push(planDesiredLinkOp(dst, entry.src, entry.kind, stagedSrcDir, state.links[recordedKey], opts));
  }

  // Prune ONLY verified v2 state.links records for ACTIVE targets.
  // Untargeted adapters are never pruned. A record whose owner cannot be resolved under the
  // current HOME is kept too: a restricted run cannot prove it belongs to an active target.
  for (const dst of Object.keys(state.links).sort()) {
    if (duplicateKeys.has(dst) || desired.has(dst) || desiredPhysical.has(physicalPath(dst))) continue;
    if (opts.activeTargets && opts.activeTargets.size < ALL_AGENTS.length) {
      const ownerTarget = resolveLinkTargetId(dst, homeDir, configBase);
      if (ownerTarget === null || !opts.activeTargets.has(ownerTarget)) continue;
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

  if (plan.actionKind === "rekey-link-record") {
    // Ledger-only: one save moves the record from its old spelling to the current one.
    const rec = state.links[plan.fromDst!];
    if (!rec) throw new Error(`rekey: no ownership record at ${plan.fromDst}`);
    hooks?.beforeLedgerOnlyCommit?.(`rekey-link-record ${plan.fromDst} -> ${plan.dst}`);
    const moved = applyStateDelta(state, { kind: "link-delete", destination: plan.fromDst! });
    // One save, one generation.
    const nextState = {
      ...applyStateDelta(moved, { kind: "link-set", destination: plan.dst, record: rec }),
      generation: state.generation + 1,
    };
    saveOwnershipState(statePath, nextState);
    return nextState;
  }

  if (plan.actionKind === "drop-duplicate-record") {
    // Ledger-only: the destination is owned through another record of the same physical path.
    hooks?.beforeLedgerOnlyCommit?.(`drop-duplicate-record ${plan.dst}`);
    const nextState = applyStateDelta(state, { kind: "link-delete", destination: plan.dst });
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
