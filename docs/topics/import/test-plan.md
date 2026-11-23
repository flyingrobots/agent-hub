# Importing: test plan

Contract ledger for [importing existing configuration](README.md).

| ID | Requirement | Oracle | Level | Status | Test |
| --- | --- | --- | --- | --- | --- |
| IMP-RT-1 | Every native entry shape round-trips, for all five adapters | 2000 generated entries, empty diff | Unit | Implemented | `import.test.ts › property: every generated native entry decompiles and compiles back to an equal entry, for all five adapters` |
| IMP-RT-2 | Native references come back as `${env:NAME}` | Deep equality | Unit | Implemented | `import.test.ts › native references come back as ${env:NAME}` |
| IMP-RT-3 | A lossy entry is refused with field paths, for every adapter | Throws or a non-empty diff | Unit | Implemented | `import.test.ts › a lossy entry is refused with an exact field diff, for every adapter` |
| IMP-EXT-1 | `extra` passes native fields through and refuses managed names | Deep equality; throws | Unit | Implemented | `import.test.ts › extra passes native fields through, and is refused when it names a field agent-hub manages` |
| IMP-EXT-2 | Codex `extra` lands in `config.toml`; `--check` clean | Parsed TOML | E2E | Implemented | `import.test.ts › Codex extra fields land in config.toml (scalars, arrays, tables) and --check is then clean` |
| IMP-EXT-3 | `extra` on the base, or naming a managed field, is refused | Exit 1 | E2E | Implemented | `import.test.ts › JSON targets get extra as written; extra on the base mcp, or naming a managed field, is refused` |
| IMP-EXT-4 | `extra` values are scanned by the detector | Warning field | E2E | Implemented | `import.test.ts › extra values are scanned by the plaintext detector` |
| IMP-AGG-1 | Identical specs become the base; overrides and `disabled` follow | Deep equality | Unit | Implemented | `import.test.ts › identical specs become the base; a differing agent gets an override; installed agents without the server are disabled` |
| IMP-AGG-2 | Aggregation is deterministic | Same bytes for reordered input; two machines | Unit, E2E | Implemented | `import.test.ts › aggregation is deterministic: the same input gives the same bytes in any insertion order`, `import-cli.test.ts › aggregation is deterministic: two identical machines give identical hub bytes` |
| IMP-AGG-3 | A server lossy in one agent is refused whole | Not written; reason names the field | Unit | Implemented | `import.test.ts › a server one agent holds losslessly and another lossily is refused as a whole, naming the field` |
| IMP-CLI-1 | Golden: Claude and Cursor import; sync is a no-op; `--check` 0 | Hub files; no sync ops; exit 0 | E2E | Implemented | `import-cli.test.ts › golden: importing Claude and Cursor servers yields a hub whose sync is a no-op and --check exits 0` |
| IMP-CLI-2 | Planning writes nothing | Tree digest of HOME unchanged | E2E | Implemented | `import-cli.test.ts › --dry-run (the default) writes nothing anywhere` |
| IMP-CLI-3 | A lossy entry stops `--apply`; nothing written | Exit 1; no hub mcp/ | E2E | Implemented | `import-cli.test.ts › a lossy entry is refused with the field that would change, and nothing is written` |
| IMP-SEC-1 | `import --apply` refuses plaintext unless `--rewrite-secrets`; output never holds the secret | Exit codes; output and hub file grep | E2E | Implemented | `import-cli.test.ts › a plaintext secret is refused unless --rewrite-secrets, which prints only variable names`, `import.test.ts › rewriting replaces each flagged literal with a reference and reports only variable names` |
| IMP-CLI-4 | Rules and skills import, then adopt | Hub files; `--check` 0 | E2E | Implemented | `import-cli.test.ts › rules and skills: an identical rules file and a skill of the agent's own are imported, then adopted` |
| IMP-CLI-5 | Differing rules files are refused | Exit 1; no hub AGENTS.md | E2E | Implemented | `import-cli.test.ts › differing rules files are refused, and nothing is written` |
| IMP-CLI-6 | The wrapper hands `import`/`pull` to the engine with their own help | Help line `command` | E2E | Implemented | `import-cli.test.ts › import and pull go through the wrapper too, with their own help` |
| IMP-PULL-1 | After `pull` of an entry added with the agent's tool, `--check` 0 | Exit 0; other agents receive it | E2E | Implemented | `import-cli.test.ts › after pulling an entry added with the agent's own tool, sync-agents --check exits 0` |
| IMP-PULL-2 | `--as-override` records the difference | `overrides.<agent>`; `--check` 0 | E2E | Implemented | `import-cli.test.ts › --as-override records a differing agent's entry as overrides.<agent>` |
| IMP-PULL-3 | `pull` refuses a lossy entry | Exit 1; nothing written | E2E | Implemented | `import-cli.test.ts › pull refuses a lossy entry with its field diff and writes nothing` |
| IMP-FIX-1 | A secret in extra is refused even with --rewrite-secrets, and never printed | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › a secret in extra is refused even with --rewrite-secrets, and never printed` |
| IMP-FIX-2 | A token pasted into bearer_token_env_var is refused without being printed | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › a token pasted into bearer_token_env_var is refused without being printed` |
| IMP-FIX-3 | Codex extra that config.toml cannot hold (nested tables) is refused at import | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › Codex extra that config.toml cannot hold (nested tables) is refused at import` |
| IMP-FIX-4 | A broken config in another agent does not block --from | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › a broken config in another agent does not block --from` |
| IMP-FIX-5 | Server names that are not valid hub names are refused; nothing is written outside the hub | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › server names that are not valid hub names are refused; nothing is written outside the hub` |
| IMP-FIX-6 | Pull --as-override sees a difference only in extra | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › pull --as-override sees a difference only in extra` |
| IMP-FIX-7 | A skill unsafe to install is refused before anything is written; differing symlink targets differ | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › a skill unsafe to install is refused before anything is written; differing symlink targets differ` |
| IMP-FIX-8 | --apply with --dry-run or -n is refused in either order | Exit code; files; output | E2E | Implemented | `import-cli.test.ts › --apply with --dry-run or -n is refused in either order` |
