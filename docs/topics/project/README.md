# Project mode

`sync-agents --project` syncs a repository's own hub, `<repo>/.agents/`, into the project-scoped
config files each agent reads from the repository. Ownership is recorded in a committed lockfile,
`.agents/sync.lock.json`. Because anyone who can open a pull request can edit that lockfile,
project mode treats it as hostile input and validates every entry before trusting it.

This page is the reference. The contract ledger is [test-plan.md](test-plan.md).

## Running it

```sh
sync-agents --project                 # the repository is the git toplevel of the working directory
sync-agents --project --dir ~/src/app # or name it
sync-agents --project --check         # exit 1 on drift or conflicts, 0 when clean
sync-agents --project --dry-run       # plan only
sync-agents --project --explain       # observed, intended and ownership for every output
sync-agents --project --relock        # rebuild the lockfile (see below)
```

With `--project`, `--dir` names the repository, not a hub. Outside a git repository and without
`--dir`, the run fails with an `agent_hub.error` line of code `config`. Without `--dir`, the
repository root that git reports must contain the working directory; otherwise (for example when
`.git/config` sets a hostile `core.worktree`) the run fails with `config` and you must name the
repository with `--dir`.

Project mode never reads or writes the user's home configs, the user hub, or the user-scope
ownership ledger. It does not read `disabledTargets` from `config.json` either, so committed outputs
do not depend on one machine's settings; only `--targets` narrows a run, and excluded targets are
never pruned. `--skill`, `--skill-only` and `--disown-legacy` are user-scope options and are usage
errors with `--project`. Output is the usual JSON Lines contract (`agent_hub.op`,
`agent_hub.conflict`, `agent_hub.warning`, `agent_hub.summary`, `agent_hub.error`); `--human`
prints prose.

## The project hub

`<repo>/.agents/` has the same layout as the user hub: `AGENTS.md`, `skills/<name>/SKILL.md`, and
`mcp/<name>/mcp.json` with the same overrides, `disabled` and per-agent override files. It must be
a real directory; a symlinked `.agents` is refused.

Everything under `.agents/mcp/` must be a real directory or a regular file. A symlink anywhere
there (the `mcp` directory itself, a server directory, an `mcp.json`, a per-agent override) or a
FIFO, device or socket fails the run with `config`, naming the path, before any server is read.
A symlink could otherwise pull config, including an allow-listed literal, from outside the
repository into committed files, and a FIFO would hang the read. Skill directories and
`.agents/AGENTS.md` that are symlinks are skipped rather than linked.

## What it writes

Project mode writes these paths and nothing else. This is the known output set: no other path is
ever written, pruned or claimed.

| Path | Kind | For | Contents |
| --- | --- | --- | --- |
| `.mcp.json` | file | Claude Code | `{"mcpServers": {...}}` |
| `.cursor/mcp.json` | file | Cursor | `{"mcpServers": {...}}` |
| `opencode.json` | file | OpenCode | `{"$schema": "https://opencode.ai/config.json", "mcp": {...}}` |
| `.codex/config.toml` | file | Codex | only `[mcp_servers.*]` tables |
| `CLAUDE.md` | symlink | Claude Code | `.agents/AGENTS.md` |
| `AGENTS.md` | symlink | Codex, Cursor, OpenCode | `.agents/AGENTS.md` |
| `.claude/skills/<name>` | symlink | Claude Code | `../../.agents/skills/<name>` |

- An agent's MCP file is written only when at least one server compiles for that agent, so a
  server disabled for Cursor, or a run with `--targets claude`, leaves `.cursor/mcp.json` out.
- The two rules links are written only when `.agents/AGENTS.md` exists. `CLAUDE.md` and the skill
  links belong to `claude:links`; `AGENTS.md` to the links domain of Codex, Cursor or OpenCode.
- JSON files are 2-space JSON with a trailing newline, servers in code-unit name order; the TOML
  comes from the same renderer as user scope, which orders keys by code unit, never by locale. The bytes depend only on the hub, never on the
  machine, the user or the repository's path.
- **Antigravity is not supported in project mode.** Its workspace MCP config path is unverified,
  so nothing is ever written for it, even with `--targets antigravity`.

## Ownership

Project outputs are generated whole; project mode never merges into a file it does not own. A
path is owned when its lockfile entry matches what is on disk: the file's sha256, or the link's
target.

| On disk | Lockfile | Result |
| --- | --- | --- |
| absent | any | created |
| equals the intended output | owned | in sync |
| equals the intended output | not owned | conflict; `--adopt` takes it |
| owned, intended output changed | owned | rewritten |
| differs, listed in the lock but edited since | digest mismatch | conflict; `--force` rewrites it |
| differs, not in the lock | none | conflict, even with `--force`: move it aside |
| a directory, or a symlink where a file belongs | any | conflict, never replaced |

A conflict exits 1 and writes nothing. The lockfile is written last and only when its bytes
change, so it never claims a file that is not yet on disk. An interrupted run can leave identical
outputs that are not yet claimed; `--adopt` or `--relock` claims them.

## The lockfile

```json
{
  "version": 1,
  "files": {
    ".mcp.json": "sha256:<64 hex>"
  },
  "links": {
    "CLAUDE.md": ".agents/AGENTS.md"
  }
}
```

Keys are sorted, paths are repo-relative, and there are no timestamps, absolute paths or user
names, so a clone on another machine produces a byte-identical lockfile and `--project --check`
exits 0 there. Commit it with the outputs. It is written atomically, always as a regular file. It
must be a regular file to be read: a symlink, FIFO or device there fails a normal run with
`config` and is never read.

## The attacker model and validation

A hostile repository controls the lockfile and the hub. Before trusting any entry, project mode
checks the whole lockfile, and any failure fails the whole run closed with an `agent_hub.error`
of code `config` and nothing written:

1. **Shape.** Valid JSON with no duplicate keys, exactly `version` (1), `files` and `links`; file
   values are `sha256:<64 hex>`; a link's value must be the one target project mode writes for that
   path.
2. **Strictly repo-relative.** Absolute paths, `..` or `.` segments, empty segments (`//`), NUL
   bytes and backslashes are rejected.
3. **Contained.** Every existing ancestor of the path must be a real directory inside the
   repository. A symlinked ancestor is refused, whether it escapes (`.claude -> /etc`) or not.
4. **Known.** The path must be in the known output set for its kind: one of the four files under
   `files`, `CLAUDE.md`, `AGENTS.md` or `.claude/skills/<valid skill name>` under `links`.
   `package.json`, `.git/hooks/pre-commit`, anything under `.agents/`, and a file path listed as a
   link are all rejected.
5. **Exact-match pruning.** A lockfile path that is no longer intended is removed only when the
   file's sha256 equals its digest, or the link's target equals its target. Anything else is a
   conflict and the path is left alone.

The same containment rule applies to every output project mode writes: it never writes through a
symlinked directory (`.cursor -> elsewhere` is refused). Plaintext secrets block: a literal that
the plaintext detector flags (outside `allowPlaintextFields`) prints its `agent_hub.warning` line
and fails the run, because project files are committed.

## Secrets

Project mode never materializes a secret.

- `${env:NAME}` compiles as in user scope: each agent's config names the variable, never a value.
- `${vault:KEY}` compiles to the exec wrapper with the bare command `sync-agents`, not an absolute
  path, so the committed files are the same on every machine. The inner server command must still
  be absolute (see [vault](../vault/README.md)). An agent launched from a GUI may not have
  `~/.local/bin` on its `PATH`; add it there, or the agent cannot start the server.
- Project mode never creates a grant. When a vault key has no matching grant on this machine, the
  final `agent_hub.summary` line's message names the exact command to run, for example
  `sync-agents secret grant github --to gh --dir /path/to/repo/.agents`. Running that command, which
  prints the exact argv it grants, is the per-key confirmation; `exec` refuses the key until then.
  Missing grants are machine-local, so they are not drift: `--check` ignores them.

## Relock

When the lockfile has a merge conflict, or after an interrupted run, `--project --relock` rebuilds
it without reading the old one. It claims each intended output whose bytes or link target already
equal the intended output and nothing else; a file whose bytes differ is left unclaimed, and the
next sync reports it. A lockfile that is not a regular file (a symlink, FIFO or device) is never
read and is replaced with a regular file; a symlink's target is left untouched.
`--relock --dry-run` shows what would be claimed. `--relock` cannot be
combined with `--targets`, `--check` or `--explain`.

## Concurrency

Apply runs on one repository are serialized by an advisory `flock(2)` writer lock at
`$XDG_STATE_HOME/agent-hub/project-locks/<sha256 of the repository's real path>.lock` (default
`~/.local/state/agent-hub/...`), outside every committed path. A second apply run while one holds
it fails with an `agent_hub.error` of code `lock` and writes nothing. That lock file, which is kept
and reused, is the only thing project mode writes outside the repository. `--check`, `--dry-run`
and `--explain` never take it.

## Case-folding volumes

On a volume that folds case (APFS and HFS+ by default), two output or lockfile paths that differ
only in case, such as `.claude/skills/demo` and `.claude/skills/Demo` after a case-only skill
rename, fail the run with `config` at plan time, before anything is written. Remove the stale link,
or run `--relock`, then sync again.

## Limits

- Empty directories (`.cursor/`, `.claude/skills/`) are left behind after a prune.
