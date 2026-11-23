# Ownership and recovery

`sync-agents` changes or deletes only what its ledger says it owns, and it finishes or safely
abandons an interrupted write before starting new work. This page is the reference for that
model. Contracts are tracked in [test-plan.md](test-plan.md).

## The ownership ledger

Machine-local state lives under `${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub/` (a relative
`XDG_STATE_HOME` is ignored), never in the hub, so the hub can live in its own git repository:

| File | Contents |
| --- | --- |
| `state-<hub-hash>.json` | The v2 ledger: a monotonic `generation`, every managed symlink (`target`, `basis`) and every managed MCP entry per target (`configPath`, content `digest`, `basis`) |
| `journal-<hub-hash>.json` | The write-ahead journal, present only while a target write is in flight |
| `apply.lock` | A persistent file locked with `flock(2)` while applying |

`<hub-hash>` is derived from the canonical hub path, so different hubs keep separate ledgers. A
ledger written by a three-target build, with no `cursor` or `opencode` maps, loads unchanged.

Ownership is never inferred:

- An existing symlink, a path that happens to point into the hub, or a disabled hub server does
  not make anything owned.
- An unmanaged entry is preserved and reported as a conflict. `--force` replaces it;
  `--adopt` records it as owned when it is equivalent to what `sync-agents` would write.
- `--check` reports ledger-only work, such as retiring a legacy claim, as drift.

## Adoption

`--adopt` records ownership of something `sync-agents` would otherwise report as a conflict:

- an identical symlink or MCP entry, recorded without rewriting it;
- a real file or directory where a link belongs, replaced by the link only if the two are
  strictly equivalent.

Strict equivalence compares every entry, including `.git`, dotfiles and empty directories; the
object kind (FIFOs, sockets and device nodes are refused); file bytes; `mode & 0o7777`;
`uid`/`gid`; `nlink === 1`; literal symlink targets (escaping relative symlinks are refused); and
extended attribute names and raw values plus ACLs. Extended attributes are read natively on
macOS and Linux. ACLs are read natively on macOS; on Linux they are read with `getfacl` when it
is installed, and otherwise are not verified and do not block adoption. Timestamps and inode
identity are not compared.

## Write-ahead recovery

Every target write is journaled first: the journal records the planned before and after
snapshots and the ledger change. The journal is cleared only after the ledger is saved. At the
start of the next run, Phase 0 inspects any journal and:

- completes the operation if the target already reached its after state, reconciling a ledger
  that was not saved or a directory swap interrupted midway;
- discards the journal if the target is still in its before state; the write is redone only if
  this run's Phase 1 plans it again, which it does not for an excluded target;
- stops, preserving the destination and the journal, if the target changed in some other way.
  The run reports `pending recovery ambiguous` and refuses to continue until it is resolved.

Phase 0 runs before target scoping is applied, so it acts on `sync-agents`' own interrupted
write whatever its target. Its result is reported separately from the run's other changes; a
preflight failure after recovery applies no new Phase 2 change.

Immediately before each Phase 2 write, the live target is compared with the planned snapshot
(contents, mode, `uid`/`gid`, or a full tree digest). A target that drifted after planning is
preserved and the write is refused.

**Scope.** These guarantees cover process interruption and ordinary I/O failures. Durability
across a machine crash or power loss is not verified.

## Concurrency

Cooperating `sync-agents` processes, even on different hubs, are serialized by `flock(2)` on
`apply.lock`. The kernel releases the lock when the holder exits, including on `SIGKILL`, and the
file itself is never deleted. Lock failures other than contention (for example an unsupported
filesystem) are reported as errors, not as "busy".

Against other applications writing the same files, the snapshot check prevents applying a stale
plan, but a window remains between that check and the atomic rename.

## Migrating legacy v1 state

A `<hub>/.mcp-managed.json` manifest from v1 is treated as unverified provenance:

1. **Identical entries.** Run `sync-agents --adopt` once to record them in the v2 ledger without
   rewriting configs.
2. **Entries already gone from the target.** The next ordinary sync retires them; `--check`
   reports this as ledger-only drift until then.
3. **Keeping a personal entry without ownership.** Withdraw or rename the hub server of that
   name, which affects every target, then run `sync-agents --disown-legacy <target>:<name>`.
4. **Replacing or deleting.** Inspect the conflict, then pass `--force`.
