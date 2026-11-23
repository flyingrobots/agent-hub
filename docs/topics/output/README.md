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
| `agent_hub.op` | stdout | One operation: planned (`phase: "plan"`, `--dry-run`), applied (`"sync"`) or explained (`"explain"`). `op` carries `domain` (`skill`, `link` or `mcp`), `action`, `status`, `destination`, `observed`, `intended`, `ownership_basis`, `reason`, `next_step` (when there is one), `target_mutation` and `ledger_mutation` |
| `agent_hub.conflict` | stderr | Something `sync-agents` refuses to change: `reason`, `next_step` when there is one, and the `op` when the refusal concerns one object |
| `agent_hub.recovery` | stdout, stderr | Phase 0 write-ahead recovery, the only place recovery is reported. `event` is `pending` (stdout: a journal is waiting, read-only modes), `recovered` (stdout: an action taken, with `action`) or `ambiguous` (stderr: refused, with `reason` and `next_step`). `classification` names the journal's state |
| `agent_hub.summary` | stdout, stderr | How the run ended; see below |
| `agent_hub.error` | stderr | A failure; see below |
| `agent_hub.help` | stdout | `--help`: `command`, `usage` (the help text) and `schemas` (every schema id), followed by one `agent_hub.schema` line per message type |
| `agent_hub.print_dir` | stdout | `--print-dir`: `hub` |
| `agent_hub.schema` | stdout | `--schema`, and after `--help`: one line per message type, with `schema_id`, `schema_version` and the `schema` |

### How a run ends

Lines are printed as they happen. Every run that gets past argument parsing ends with exactly
one `agent_hub.summary` or `agent_hub.error` line, and it is the last line of the run. For
`applied`, `changes` is the number of `op` lines with `phase: "sync"` the run printed. A reader
that closes the pipe early (`| head -1`) gets no more lines; the run carries on and exits as it
would have.

| `summary.status` | Stream | Exit | Meaning |
| --- | --- | --- | --- |
| `in_sync` | stdout | 0 | Nothing to do |
| `planned` | stdout | 0 | `--dry-run` or `--explain`: `changes` changes would be made; nothing was changed |
| `applied` | stdout | 0 | A sync made `changes` changes |
| `recovered_in_sync` | stdout | 0 | Phase 0 recovery finished, and then nothing else was needed |
| `pending_recovery` | stdout (dry-run), stderr (`--check`) | 0, 1 with `--check` | A recovery journal is waiting; run `sync-agents` to finish it |
| `out_of_sync` | stderr | 1 | `--check`: `changes` changes are needed |
| `conflicts` | stderr | 1 | `conflicts` conflicts were found; nothing new was applied (each has its own `conflict` line) |

| `error.code` | Exit | When |
| --- | --- | --- |
| `usage` | 2 | Bad arguments or flag combinations. Before parsing succeeds this is the only line, and it carries `usage` |
| `config` | 1 | `agent-hub/config.json` or the hub path is invalid (an unknown `disabledTargets` selector, a path containing a newline) |
| `hub_not_found` | 1 | The resolved hub directory does not exist |
| `lock` | 1 | Another run holds the apply lock |
| `plan` | 1 | Planning failed: a target config was refused (strict JSON, TOML the editor cannot change, a moved layout), a skill source could not be read, or the ledger is unreadable. `detail` holds the cause |
| `recovery` | 1 | A pending recovery is ambiguous; the `recovery` line before it says why |
| `apply` | 1 | A write failed part-way: `committed` and `pending` list what was and was not done, and `journal` names a kept recovery journal |
| `internal` | 1 | Anything else that threw |

Exit codes are unchanged from the prose output: `0` success, `1` drift, conflict or failure,
`2` a usage error.

## Versions

Each message type has its own version, independent of the agent-hub release version, and every
schema forbids fields it does not list. So a change a consumer validating against the old schema
would reject, including a new field or a new enum value, is a major version bump of that schema.
A minor bump is reserved for changes no valid line notices, such as a clarified description.

## Detecting the contract

`sync-agents --schema` exits 0 on a version that prints JSON Lines. A version before it rejects
`--schema`, and `--human`, as unknown options (exit 2).

## Where the contract does not hold

These are the cases where a line may not be JSON, or may not be valid UTF-8:

- a hard crash of the Bun runtime or the compiled binary itself (an out-of-memory abort, a
  segfault in a native module), or a signal that kills the process; the run then also lacks its
  final `summary` or `error` line;
- an error from `bash` itself before the wrapper's first line runs, or `bun` failing to start;
- `bin/sync-agents --print-dir` with a path that is not valid UTF-8: the wrapper copies the bytes
  into the line as they are (the engine replaces them);
- `bin/sync-agents --help` without Bun prints only the `agent_hub.help` line, since only the
  engine carries the schemas (they are also installed in `schemas/`).

Everything else the engine or the wrapper reports is a schema'd line, including the output of
the programs it runs (`git`, `tar`, `unzip`), which arrives inside an `agent_hub.error` line. A
throw nothing else caught becomes an error with code `internal`. `install.sh` talks to a person
and prints prose; it calls `sync-agents` with `--human`.
