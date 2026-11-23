# Output

`sync-agents` prints JSON Lines: one JSON object per line, on stdout and stderr alike. Every
line names the schema it validates against. `--human` (alias `--humanize`) prints the same
messages as prose instead, and nothing else switches the format: output does not change with
whether it goes to a terminal.

This page is the reference for that contract. The schemas themselves are in
[`schemas/`](../../../schemas/), and `sync-agents --schema` prints them.

## A line

Every line carries four fields, followed by the fields of its message type:

| Field | Meaning |
| --- | --- |
| `_schema` | `{"id": "<message type>", "version": "<semver>"}`: the schema this line validates against |
| `kind` | The message type without its `agent_hub.` prefix: a discriminator for consumers |
| `run_id` | 16 hex characters, the same on every line of one invocation and different across invocations |
| `message` | The prose `--human` prints for this line (it may span several lines of text) |

For example, `sync-agents --print-dir` prints a line like this one (illustrative; the run id
and path differ):

```json
{"_schema":{"id":"agent_hub.print_dir","version":"1.0.0"},"kind":"print_dir","run_id":"4ad8cfb013f2619f","message":"/home/me/.agents","hub":"/home/me/.agents"}
```

`sync-agents --print-dir --human` prints `/home/me/.agents`. In a script, use `--human` to get
the bare path, or read `.hub` from the JSON line.

## Message types

| Schema id | Stream | Printed for |
| --- | --- | --- |
| `agent_hub.op` | stdout | One operation: planned (`phase: "plan"`, `--dry-run`), applied (`"sync"`) or explained (`"explain"`). `op` carries `domain`, `action`, `status`, `destination`, `observed`, `intended`, `ownership_basis`, `reason`, `next_step?`, `target_mutation`, `ledger_mutation` |
| `agent_hub.conflict` | stderr | Something `sync-agents` refuses to change: `reason`, `next_step?` and the `op` |
| `agent_hub.recovery` | stdout, stderr | Phase 0 write-ahead recovery: `event` is `pending`, `recovered` or `ambiguous` |
| `agent_hub.summary` | stdout, stderr | The outcome: `status` is `in_sync`, `out_of_sync`, `conflicts`, `recovered_in_sync`, `pending_recovery` or `applied`, with `changes` or `conflicts` counts |
| `agent_hub.error` | stderr | A failure. `code` is `usage` (exit 2), or `config`, `hub_not_found`, `lock`, `plan`, `apply` or `internal` (exit 1). An apply failure adds `committed`, `pending` and, when a journal is kept, `journal` |
| `agent_hub.help` | stdout | `--help`: `command`, `usage` (the help text) and `schemas` (every schema id the command can print) |
| `agent_hub.print_dir` | stdout | `--print-dir`: `hub` |
| `agent_hub.schema` | stdout | `--schema`: one line per message type, with `schema_id`, `schema_version` and the `schema` |

Exit codes are unchanged: `0` success, `1` drift, conflict or failure, `2` a usage error.

## Versions

Each message type has its own version, independent of the agent-hub release version. A change
that a consumer validating against the old schema would reject is a major version bump of that
schema; an added optional field is a minor one.

## Where the contract does not hold

These are the cases where a line may not be JSON:

- a hard crash of the Bun runtime or the compiled binary itself (an out-of-memory abort, a
  segfault in a native module), or a signal that kills the process;
- an error from `bash` itself before the wrapper's first line runs, or `bun` failing to start.

Every error the engine or the wrapper can report is a schema'd `agent_hub.error` line; a throw
nothing else caught becomes one with code `internal`. `install.sh` talks to a person and prints
prose; it calls `sync-agents` with `--human`.
