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
| INST-SRC-5 | Bash canonicalizers agree with the engine: relative paths from a symlinked cwd, unreadable `config.json`, newline | Equal `--print-dir`; refusals | E2E | Implemented | `hardening.test.ts › a relative AGENTS_DIR with '..' from a symlinked cwd resolves like the engine (physical cwd)` |
| INST-SRC-7 | A prefix that is an exported `AGENTS_DIR` is refused even when `--agents-dir` names another hub | Exit 1 naming `AGENTS_DIR`; prefix not created | E2E | Implemented | `hardening.test.ts › install.sh refuses a --prefix that is an exported AGENTS_DIR even when --agents-dir names another hub (Baker Street PR #17 CK-F-3)` |
| INST-SRC-8 | The hub-overlap guard handles a hub path containing `\|` | Exit 1; prefix not created | E2E | Implemented | `hardening.test.ts › the hub-overlap guard handles a hub path containing a pipe character (Baker Street PR #17 recheck R-1)` |
| INST-SRC-4 | The hub-overlap guard and the engine agree on `..` paths, so a prefix that is the hub is refused | Both `--print-dir` paths equal; install exit 1, prefix not created | E2E | Implemented | `hardening.test.ts › AGENTS_DIR=<h>/nope/../rt with --prefix <h>/rt is refused as overlapping, and both print-dir paths agree` |

## Binary layout

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| INST-BIN-1 | `bun run build:bin` produces a native executable | ELF or Mach-O header | E2E | Implemented | `binary.test.ts › bun run build:bin produces a native dist/sync-agents executable` |
| INST-BIN-2 | `build:bin` leaves no `.bun-build` files | Directory listings | E2E | Implemented | `binary.test.ts › bun run build:bin leaves no .bun-build temp files in the repo or dist/` |
| INST-BIN-3 | `flock(2)` works inside the compiled binary: a held lock refuses a second run, and the next run recovers after `SIGKILL` | Refusal message; journal recovered; `--check` exit 0 | E2E | Implemented | `binary.test.ts › flock(2) inside compiled binaries: SIGKILL mid-apply is refused while held, then recovered by the next binary run` |
| INST-BIN-4 | The `adapters`, `agent-hub` and `hardening` end-to-end suites pass against the compiled binary | Same suites, `AGENT_HUB_BINARY` set | E2E (CI step "Run end-to-end suites against the compiled binary") | Implemented | — |
| INST-BIN-9 | A full sync with the compiled binary passes `--check` and re-syncs with zero churn | Exit codes; no `[sync]` line on the re-sync | E2E | Implemented | `binary.test.ts › golden: full sync of links, skills and MCP, then --check exits 0 and re-sync is zero-churn` |
| INST-BIN-5 | `install.sh --binary` installs the binary with marker and shim semantics, and passes `--check` | Marker `layout: binary`; `--check` exit 0 | E2E | Implemented | `binary.test.ts › installs the compiled binary as the runtime, keeps marker and shim semantics, and passes --check` |
| INST-BIN-6 | Switching between layouts replaces the runtime in place under the marker guard | Layout and tree after each install | E2E | Implemented | `binary.test.ts › swaps between source and binary layouts in place under the existing marker guard` |
| INST-BIN-7 | `--binary` refuses a missing argument, a non-executable, a non-native file (including a shebang-less script), a quarantined macOS download, and a non-agent-hub program, leaving the prefix untouched | Exit codes and messages; prefix absent | E2E | Implemented | `binary.test.ts › refuses a missing argument, a non-executable, a script, or a non-agent-hub program, leaving the prefix untouched` |
| INST-BIN-8 | Without Bun, replacing an existing binary runtime is one atomic exchange | No `mv` of the prefix during the upgrade | E2E | Implemented | `binary.test.ts › without Bun on PATH, upgrading a binary runtime is one atomic exchange (no two-step rename)` |
| INST-BIN-10 | Without Bun or python3, a prefix that is the configured hub is refused | Exit 1; prefix not created | E2E | Implemented | `binary.test.ts › without Bun or python3, the binary's own hub view still blocks a prefix that is the configured hub` |
| INST-BIN-11 | The binary's own `--print-dir` blocks a prefix that the wrapper's view misses | Exit 1 naming the binary's view; killed by a mutant that drops it | E2E | Implemented | `binary.test.ts › the binary's own --print-dir blocks a prefix the wrapper's view misses (Baker Street PR #17 CK-F-1)` |
| INST-SRC-6 | A source-layout install without Bun swaps atomically | No moment without a runtime | — | Gap: falls back to two renames (documented above) | — |

## Release workflow

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| INST-REL-1 | A tag that does not match `package.json`, is not on `main`, or already has a release is refused | Workflow fails before building | Workflow run | Gap: verified only by reading the workflow until the first release | — |
| INST-REL-2 | Published assets match `SHA256SUMS` and carry provenance attestations | `sha256sum -c`; `gh attestation verify` | Release check | Gap: checked at the first release (flyingrobots/agent-hub#9) | — |
| INST-ISO-1 | The wrapper, its `bun` config reader, and a sync ignore the working directory's `.env*`, `bunfig.toml`, and a `tsconfig.json`/`jsconfig.json` there or above | Printed hub; ledger location; no preload marker | E2E | Implemented | `cwd-autoload.test.ts › wrapper --print-dir, through its bun config reader, is neither redirected nor preloaded`, `cwd-autoload.test.ts › a sync through the wrapper writes its ledger under the real state home and runs no preload` |
| INST-ISO-2 | `install.sh` runs no working-directory preload | No marker; config.json written to the real config home | E2E | Implemented | `cwd-autoload.test.ts › install.sh run from such a directory runs no preload, including its bun helpers` |
| INST-ISO-3 | Every `bun` call in the scripts carries the isolation flags | Source check of each call and both runners | Unit | Implemented | `cwd-autoload.test.ts › every bun invocation in bin/sync-agents and install.sh passes the isolation flags` |
| INST-ISO-4 | The binary is compiled with all four autoloads off and ignores `.env`, `bunfig.toml` and `tsconfig.json` | Build flags in `build:bin` and `release.yml`; run from a hostile directory | E2E | Implemented | `cwd-autoload.test.ts › the binary is compiled without .env, bunfig.toml, tsconfig.json or package.json autoloading, by build:bin and the release workflow`, `binary.test.ts › the binary ignores a .env, a bunfig.toml preload and a tsconfig paths hijack in its working directory (flyingrobots/agent-hub#26)` |
