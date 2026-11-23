# Output: test plan

Contract ledger for [the output reference](README.md). Every test spawning `sync-agents` in this
repository also validates each line it prints against its schema (`test/jsonl.ts`), so the cases
below are the dedicated ones.

| ID | Requirement | Oracle | Level | Status | Test |
| --- | --- | --- | --- | --- | --- |
| OUT-SCH-1 | `schemas/` and the registry agree, and each schema pins its own id and version | File list equals registry; `const` id and version | Unit | Implemented | `output-contract.test.ts › every file in schemas/ is a registered message schema, and every registered schema is a file` |
| OUT-SCH-2 | `--schema` prints one valid line per schema; each schema compiles | ajv compile | E2E | Implemented | `output-contract.test.ts › --schema prints one valid line per declared schema, and each printed schema compiles` |
| OUT-HLP-1 | `--help` is an `agent_hub.help` line followed by the schema of every message type, from the engine, `mcp-sync` and the wrapper | Decoded line | E2E | Implemented | `output-contract.test.ts › --help is an agent_hub.help line then every schema, from the engine, mcp-sync and the wrapper` |
| OUT-HLP-2 | The wrapper's help text is the engine's | String equality | E2E | Implemented | `output-contract.test.ts › the wrapper's help text is the engine's help text` |
| OUT-HUM-1 | `--human` / `--humanize` print prose | No JSON lines; bare path | E2E | Implemented | `output-contract.test.ts › --human prints prose, not JSON, for help, print-dir and a sync` |
| OUT-ERR-1 | A usage error is one `agent_hub.error` line, code `usage`, exit 2, empty stdout | Decoded line | E2E | Implemented | `output-contract.test.ts › a usage error is one agent_hub.error line with code usage on stderr, exit 2, nothing on stdout` |
| OUT-RUN-1 | Apply, check, dry-run, explain and conflict runs print only valid lines with one `run_id` | Decoded lines | E2E | Implemented | `output-contract.test.ts › apply, check, dry-run, explain and a conflict all print only valid lines sharing one run_id per run` |
| OUT-RUN-2 | Different runs have different `run_id`s | Inequality | E2E | Implemented | `output-contract.test.ts › two runs carry different run_ids` |
| OUT-WRP-1 | A wrapper message with control characters is still one valid line | Round-trip | E2E | Implemented | `output-contract.test.ts › a wrapper message with control characters is still one valid JSON line` |
