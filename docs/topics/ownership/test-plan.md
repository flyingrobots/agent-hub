# Ownership and recovery: test plan

Contract ledger for [Ownership and recovery](README.md). Tests are cited as
`<file> › <exact test name>` under `test/`; the documentation gate fails if a cited test does not
exist.

## Ledger and ownership

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| OWN-LED-1 | Ledger-only changes are visible to `--check`, and stable runs leave the ledger byte-identical | `--check` exit; state bytes and generation | E2E | Implemented | `agent-hub.test.ts › Contract 5 (Amendment 5): ledger-only changes visible to --check and stable runs have zero churn` |
| OWN-LED-2 | A mixed conflict fails closed with no target or ledger write | Snapshots before and after | E2E | Implemented | `agent-hub.test.ts › Contract 6 (MUST #5): mixed conflict with no pending recovery fails closed with zero target or ledger writes` |
| OWN-LED-3 | Corrupt or truncated state and journal files fail closed with a schema error | Exit 1, message | E2E | Implemented | `hardening.test.ts › F6: corrupt/truncated state and journal files fail closed with schema validation errors` |
| OWN-LED-4 | A three-target ledger loads with zero churn | State bytes | E2E | Implemented | `adapters.test.ts › backward-compatible loading of existing 3-agent v2 ledger causes zero churn` |

## Adoption

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| OWN-ADO-1 | Symlink existence never grants ownership; adoption requires strict equivalence (`.git`, mode, xattr values, escaping symlinks) | Conflicts reported; adopt succeeds only when equivalent | E2E | Implemented | `agent-hub.test.ts › Contract 4 (MUST #3 + Amendment 3): honest symlink ownership & strict adoption equivalence (.git, mode, xattr values, escaping symlinks)` |
| OWN-ADO-2 | `--adopt --skill <src>` installs and adopts an identical existing copy in one run | Ledger record, link | E2E | Implemented | `hardening.test.ts › F9: --adopt --skill <src> installs and adopts identical existing target copy in a single pass` |
| OWN-ADO-3 | Extended attributes and ACLs are read natively, quickly, and Linux `ENOTSUP` is classified safely | Timing bound; no subprocesses; classification | Unit | Implemented | `hardening.test.ts › F15 & F16: native FFI xattr/ACL reads 100-file tree fast (zero subprocesses) and classifies Linux ENOTSUP safely` |

## Recovery

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| OWN-REC-1 | A state-save failure after a successful config write recovers on the next run without `--adopt` or `--force` | Ledger converges; next run zero-churn | E2E | Implemented | `recovery.test.ts › state save failure after successful config write recovers without --adopt or --force, then is zero-churn` |
| OWN-REC-2 | `SIGKILL` after a link write, before the ledger commit: the kernel releases the lock and the next run reconciles | Lock acquirable; ledger converges | E2E | Implemented | `recovery.test.ts › literal child-process SIGKILL after link mutation before ledger commit: kernel releases flock and restart reconciles` |
| OWN-REC-3 | An interrupted skill directory swap recovers with no generation bump | Generation unchanged | E2E | Implemented | `recovery.test.ts › interrupted populated skill swap (ledger-neutral) recovers with zero generation bump` |
| OWN-REC-4 | Recovery interrupted after the ledger commit and run again is a no-op | Zero churn | E2E | Implemented | `recovery.test.ts › recovery running twice (interrupted after state commit before journal clear) is zero-churn no-op` |
| OWN-REC-5 | A mode-only drift or an unrelated edit between plan and apply is refused | Write refused; file preserved | E2E | Implemented | `recovery.test.ts › mode-only drift (0644 -> 0600, identical bytes) and unrelated edit at plan/apply barrier are refused` |
| OWN-REC-6 | Phase 0 success followed by a Phase 1 failure reports recovery separately and applies no new Phase 2 write | Output; snapshots | E2E | Implemented | `recovery.test.ts › Phase 0 recovery succeeds then Phase 1 preflight fails: recovery reported separately, no new Phase 2 writes` |
| OWN-REC-7 | Applied MCP write with an incomplete ledger reconciles, and the next run converges | Ledger and target | E2E | Implemented | `recovery.test.ts › mcp-write target applied, ledger incomplete -> reconciles & next run converges` |
| OWN-REC-8 | A forced delete of an unmanaged disabled entry completes with no generation bump | Generation | E2E | Implemented | `recovery.test.ts › mcp-write forced delete of unmanaged disabled entry (ledger-neutral) -> completes with zero generation bump` |
| OWN-REC-9 | An adoption copy interrupted mid-swap completes and cleans its backup | Destination and backup | E2E | Implemented | `recovery.test.ts › link-adopt-copy interrupted mid-swap (committed backup rename) -> completes switch & cleans backup` |
| OWN-REC-10 | A target changed unexpectedly after interruption is preserved with its journal, and the next run is blocked | Destination bytes; journal present; exit 1 | E2E | Implemented | `recovery.test.ts › ambiguous target modified unexpectedly after interruption -> preserves destination & journal, blocks next run` |
| OWN-REC-11 | Phase 0 recovery of a journal whose target is excluded by `--targets` leaves an edited target untouched and refuses | Target bytes; exit 1 | E2E | Gap: exercised by a review probe (Baker Street round 1, Moriarty M-A-6), not a maintained test | — |

## Concurrency

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| OWN-LOCK-1 | Two contenders after a dead owner never both hold the lock | Lock holders | E2E | Implemented | `recovery.test.ts › two-contender flock exclusion after dead owner (SIGKILL): never admits overlapping ownership` |
| OWN-LOCK-2 | `flock` errors other than contention are distinguished from "busy" | errno classification | Unit | Implemented | `hardening.test.ts › F2: flock(2) errno inspection distinguishes EWOULDBLOCK from EBADF/ENOLCK/EOPNOTSUPP` |

## Legacy v1 migration

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| OWN-V1-1 | The full v1 lifecycle (adopt, retire absent, disown, force) behaves as documented | Ledger and target per step | E2E | Implemented | `agent-hub.test.ts › Contract 2 (Amendment 5): full legacy v1 .mcp-managed.json lifecycle (L1-L6) & --disown-legacy` |
| OWN-V1-2 | `--disown-legacy` naming a target excluded from the run reports it rather than silently doing nothing | Nonzero exit with message | E2E | Planned: flyingrobots/agent-hub#3 | — |
