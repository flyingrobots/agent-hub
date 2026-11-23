# Commands and agents: test plan

Contract ledger for [commands and agents](README.md).

| ID | Requirement | Oracle | Level | Status | Test |
| --- | --- | --- | --- | --- | --- |
| PRIM-CMD-1 | A command syncs to every agent with a commands directory, in its own shape; zero churn | File contents; `--check` 0; no sync ops on re-run | E2E | Implemented | `primitives.test.ts › a command syncs to every agent with a commands directory, in each agent's own shape` |
| PRIM-AGT-1 | An agent syncs to Claude, OpenCode (subagent), Cursor and Codex (TOML) | Parsed frontmatter / TOML | E2E | Implemented | `primitives.test.ts › an agent definition syncs to Claude, OpenCode (as a subagent), Cursor and Codex (TOML)` |
| PRIM-SKIP-1 | An agent without its root directory is skipped | Nothing created | E2E | Implemented | `primitives.test.ts › an agent whose root directory does not exist is skipped` |
| PRIM-REF-1 | Incompatible frontmatter or body fails closed; nothing written | Exit 1 naming the field; no files | E2E | Implemented | `primitives.test.ts › incompatible frontmatter or body fails closed, and nothing is written` |
| PRIM-TGT-1 | `targets.<agent>` reaches that agent only | File contents | E2E | Implemented | `primitives.test.ts › targets.<agent> adds frontmatter for that agent only` |
| PRIM-OWN-1 | Removal prunes unchanged files; an edited one is a conflict until `--force` | Files; ledger | E2E | Implemented | `primitives.test.ts › removing a command prunes the files agent-hub wrote; an edited one is a conflict and kept` |
| PRIM-OWN-2 | An identical unmanaged file is adopted only with `--adopt`; a different one is replaced only with `--force` | Exit codes; basis; contents | E2E | Implemented | `primitives.test.ts › an existing file agent-hub did not write: identical is adopted with --adopt, different is replaced only with --force` |
| PRIM-SCOPE-1 | A scoped run touches only active targets' files, and only in the links domain | Files | E2E | Implemented | `primitives.test.ts › a scoped run writes and prunes only the active targets' files` |
| PRIM-REC-1 | An interrupted write is reconciled by the next run | Ledger record; `--check` 0 | E2E | Implemented | `primitives.test.ts › a write interrupted after the file and before the ledger is reconciled by the next run` |
