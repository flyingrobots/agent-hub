# Installing and releasing: test plan

Contract ledger for [Installing and releasing](README.md). Tests are cited as
`<file> › <exact test name>` under `test/`; the documentation gate fails if a cited test does not
exist.

## Source layout

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| INST-SRC-1 | `install.sh` installs an isolated source runtime with its marker, and the result passes `--check` | Marker present; `--check` exit 0 | E2E | Implemented | `agent-hub.test.ts › install.sh creates isolated install with .agent-hub-runtime marker and passes --check` |
| INST-SRC-2 | `install.sh` never passes `--force`, scopes `--force-skill`, and guards the prefix and shim | Exit codes; preserved files per case | E2E | Implemented | `agent-hub.test.ts › Contract 3 (MUST #2 + SHOULD #4): installer never supplies global force, scopes --force-skill, and guards --prefix & shim` |
| INST-SRC-3 | Relative shim resolution, missing-argument exit 2, `--opt=val`, and an atomic runtime swap | Per case | E2E | Implemented | `hardening.test.ts › F7 & F8 & F13: install.sh relative shim resolution, missing-arg exit 2, --opt=val, and atomic swap` |
| INST-SRC-4 | The hub-overlap guard and the engine agree on `..` paths, so a prefix that is the hub is refused | Both `--print-dir` paths equal; install exit 1, prefix not created | E2E | Implemented | `hardening.test.ts › AGENTS_DIR=<h>/nope/../rt with --prefix <h>/rt is refused as overlapping, and both print-dir paths agree` |

## Binary layout

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| INST-BIN-1 | `bun run build:bin` produces a native executable | ELF or Mach-O header | E2E | Implemented | `binary.test.ts › bun run build:bin produces a native dist/sync-agents executable` |
| INST-BIN-2 | `build:bin` leaves no `.bun-build` files | Directory listings | E2E | Implemented | `binary.test.ts › bun run build:bin leaves no .bun-build temp files in the repo or dist/` |
| INST-BIN-3 | `flock(2)` works inside the compiled binary: a held lock refuses a second run, and the next run recovers after `SIGKILL` | Refusal message; journal recovered; `--check` exit 0 | E2E | Implemented | `binary.test.ts › flock(2) inside compiled binaries: SIGKILL mid-apply is refused while held, then recovered by the next binary run` |
| INST-BIN-4 | The `adapters`, `agent-hub` and `hardening` end-to-end suites pass against the compiled binary | Same suites, `AGENT_HUB_BINARY` set | E2E (CI step "Run end-to-end suites against the compiled binary") | Implemented | — |
| INST-BIN-9 | A full sync with the compiled binary passes `--check` and re-syncs with zero churn | Exit codes; ledger bytes | E2E | Implemented | `binary.test.ts › golden: full sync of links, skills and MCP, then --check exits 0 and re-sync is zero-churn` |
| INST-BIN-5 | `install.sh --binary` installs the binary with marker and shim semantics, and passes `--check` | Marker `layout: binary`; `--check` exit 0 | E2E | Implemented | `binary.test.ts › installs the compiled binary as the runtime, keeps marker and shim semantics, and passes --check` |
| INST-BIN-6 | Switching between layouts replaces the runtime in place under the marker guard | Layout and tree after each install | E2E | Implemented | `binary.test.ts › swaps between source and binary layouts in place under the existing marker guard` |
| INST-BIN-7 | `--binary` refuses a missing argument, a non-executable, a non-native file (including a shebang-less script), a quarantined macOS download, and a non-agent-hub program, leaving the prefix untouched | Exit codes and messages; prefix absent | E2E | Implemented | `binary.test.ts › refuses a missing argument, a non-executable, a script, or a non-agent-hub program, leaving the prefix untouched` |
| INST-BIN-8 | Without Bun, replacing an existing runtime is atomic | No moment without a runtime | — | Gap: falls back to two renames (documented above) | — |

## Release workflow

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| INST-REL-1 | A tag that does not match `package.json`, is not on `main`, or already has a release is refused | Workflow fails before building | Workflow run | Gap: verified only by reading the workflow until the first release | — |
| INST-REL-2 | Published assets match `SHA256SUMS` and carry provenance attestations | `sha256sum -c`; `gh attestation verify` | Release check | Gap: checked at the first release (flyingrobots/agent-hub#9) | — |
