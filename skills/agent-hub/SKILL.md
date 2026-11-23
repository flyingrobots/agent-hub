---
name: agent-hub
description: Manage local AI coding agent configuration through a canonical agents hub directory (default ~/.agents/) and the sync-agents CLI. Use whenever the user asks to install, update, create, or remove an agent skill; add, override, disable, or remove an MCP server; edit global agent instructions; or sync/check drift across Claude Code, Codex, Antigravity, Cursor, and OpenCode.
---

# Agent Hub (`sync-agents`)

Shared configuration for local AI coding agents lives in a canonical hub directory (default **`~/.agents/`**, configurable via `--dir`, `$AGENTS_DIR`, or `~/.config/agent-hub/config.json`) and is synchronized across **Claude Code**, **Codex**, **Antigravity**, **OpenCode**, and **Cursor** (global Cursor rules unverified/experimental) by running **`sync-agents`**.

> **Note:** **Gemini CLI** (`~/.gemini/settings.json`) is not currently supported by the MCP compiler. The `antigravity` adapter targets Antigravity's `~/.gemini/config/mcp_config.json`.

Run `sync-agents --print-dir --human` to confirm the canonical resolved hub path.

**Bringing existing configuration in.** When a user already has MCP servers, rules or skills in their agents, run `sync-agents import` first (it only plans), show the user what it would import and what it refuses, then `sync-agents import --apply --adopt` with their agreement. After a user adds a server with an agent's own tool (`claude mcp add`), use `sync-agents pull --from <agent> mcp/<name> --apply` rather than editing the hub by hand. Never pass `--rewrite-secrets` without telling the user which variables they will need to set.

**Commands and agents.** To share a slash command or a subagent, write `<hub>/commands/<name>.md` or `<hub>/agents/<name>.md` (name in `^[a-z0-9][a-z0-9-]*$`) and run `sync-agents`. Use only `description` and `argument-hint` (commands) or `description` and `model: inherit` (agents) at the top level, `$ARGUMENTS` rather than `$1`, and put anything tool- or model-specific under `targets.<agent>`; a refusal names the field to move.

**One machine differs.** When a hub server needs a different `command` on this machine, its program is not installed here, or one agent already has a personal entry of the same name, do not edit the hub and do not exclude the whole target. Write a machine override in `${XDG_CONFIG_HOME:-~/.config}/agent-hub/machine.json`: `{ "mcp": { "<server>": { "mcp": { "command": "..." }, "overrides": { "<agent>": { "disabled": true } } } } }`. It can only change or disable servers the hub defines. A server disabled for an agent there leaves that agent's own entry of the same name untouched. The summary line's `machine_overrides` counts the overrides in effect; `--explain` names the file in each affected reason. Reference: `docs/topics/mcp/README.md`, Machine overrides.

**Secrets in MCP servers.** Never write a token, password or API key into a hub `mcp.json`. Use `${env:NAME}` (NAME in `^[A-Z_][A-Z0-9_]*$`) and tell the user which variable to set in their environment; `sync-agents` compiles it per agent and never reads it. A `warning` line with code `plaintext_secret` names a field holding a literal credential, and the sync refuses (a conflict, exit 1, nothing written) until it is fixed: offer to replace it with a reference. When you do, never print, echo or copy the existing value (not into a message, a shell profile, `launchctl` or another file): tell the user which variable to set and where (shell profile for terminal agents; `launchctl setenv` or launching from a shell for apps started from the Dock), let them set it themselves, and recommend rotating the credential, since it has already been written into every agent's config and possibly the hub's git history. Only add the field to `allowPlaintextFields` when the user confirms the value is not secret. Codex accepts only `KEY = "${env:KEY}"` in `env`, `Authorization: "Bearer ${env:X}"`, or a whole-value header reference; Antigravity accepts none, so suggest `overrides.antigravity.disabled: true` when a server needs one.

**Vault secrets (macOS, stdio servers, every agent including Antigravity).** Write `${vault:KEY}` as a whole `env` value; sync compiles the server to `sync-agents exec`. The user stores the value themselves with `printf '%s' "$VALUE" | sync-agents secret set KEY` (never run it with a value you were shown, and never put a value in an argv), then `sync-agents secret grant KEY --to SERVER`. Re-grant after changing that server's `command` or `args`. `exec` refuses anything without an exact grant. It protects config files on disk, not against code running as the user (see `docs/topics/vault/README.md`).

**Output is JSON Lines.** Every line `sync-agents` prints, on stdout and stderr, is one JSON object with `_schema` (`id`, `version`), `kind`, `run_id` and `message`. Parse the lines and branch on `kind`: `op` (a planned, applied or explained change, in `op`), `conflict` (a refusal, with `reason` and `next_step`), `recovery` (`event`: `pending`, `recovered`, `ambiguous`), `summary` (`status`), `error` (`code`), `help`, `print_dir` (`hub`), `schema`, `warning` (`code`). Every run ends with exactly one `summary` or `error` line; read the outcome from it and from the exit code, and the table in `docs/topics/output/README.md` says what each `status` and `code` means. A strict-JSON or TOML refusal is an `error` with code `plan`, not a `conflict`. `message` is the prose a person would read; quote it to the user. Pass `--human` only when you want prose instead, for example `"$(sync-agents --print-dir --human)"` in a shell command. `sync-agents --schema` prints every schema. If a line is not JSON, or a run ends without a `summary` or `error` line, treat the run as failed and show the user the raw output; if `sync-agents --schema` exits 2, the installed runtime predates JSON Lines, so use its prose output.

## Golden Rule

1. **Always edit inside the canonical hub (`~/.agents/`)** — never edit per-agent synced targets directly:
   - Instructions symlinks: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `${XDG_CONFIG_HOME:-~/.config}/opencode/AGENTS.md`, `~/.cursor/AGENTS.md` *(unverified)*
   - Per-skill symlinks: `~/.claude/skills/<name>`, `~/.codex/skills/<name>`, `~/.gemini/skills/<name>`, `${XDG_CONFIG_HOME:-~/.config}/opencode/skills/<name>`, `~/.cursor/skills/<name>`
   - Compiled MCP entries: `~/.gemini/config/mcp_config.json` (`antigravity`), `mcpServers` in `~/.claude.json` (`claude`), `[mcp_servers.*]` in `~/.codex/config.toml` (`codex`), `mcpServers` in `~/.cursor/mcp.json` (`cursor`), `mcp.servers` in `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json` (`opencode`). A `mcp-migrate-layout` line in a plan moves an entry agent-hub wrote in OpenCode's old `mcp.<name>` layout; a conflict over an old-layout entry is not resolved by `--force` or `--adopt` — tell the user, and offer to exclude `opencode:mcp`
2. **Always finish with `sync-agents` and verify with `sync-agents --check`.**

---

## Canonical Hub & State Layout

| Path | Purpose | Sync / Ownership Mechanism |
| --- | --- | --- |
| `<hub>/AGENTS.md` | Shared global instructions (repo-level `AGENTS.md` / `CLAUDE.md` still take precedence) | Managed symlink to each installed agent's rules file |
| `<hub>/skills/<name>/SKILL.md` | Canonical skill directories (with optional `references/`, `scripts/`, assets) | Managed per-skill symlinks into each agent's `skills/` dir |
| `<hub>/mcp/<name>/mcp.json` | Canonical MCP server definition (+ optional inline `overrides.<agent>` or `<agent>/mcp.json`) | Compiled by `sync-agents` into each agent's native MCP config |
| `~/.local/state/agent-hub/state-<hash>.json` | Machine-local v2 ownership ledger (symlinks + MCP content digests + monotonic `generation`) | Managed automatically outside git-tracked `<hub>` — do not hand-edit |
| `~/.local/state/agent-hub/journal-<hash>.json` | Write-ahead recovery journal present only during in-flight mutations | Reconciled automatically by Phase 0 recovery on next `sync-agents` run |

---

## Common Workflows

### 1. Install or Update a Skill

`sync-agents --skill <src>` accepts:
- **Git repository URL** (`https://...`, `http://...`, `ssh://...`, `git://...`, `git@...`) — shallow-cloned, `.git/` stripped
- **Local directory** containing `SKILL.md` (or `skills/<name>/SKILL.md`)
- **Git `.bundle`**, **`.zip` / `.skill`**, or **tarball** (`.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`)

The skill name is read from `name:` in `SKILL.md` YAML frontmatter (falling back to the directory/archive name).

```bash
# Preview first when unsure (leaves final hub & agent destinations unchanged;
# remote URLs/archives unpack to a temporary directory cleaned up on exit)
sync-agents --dry-run --skill https://github.com/owner/repo.git

# Install and sync across all installed agents
sync-agents --skill https://github.com/owner/repo.git

# Update an already-installed canonical skill ONLY (never authorizes MCP or symlink overwrite)
sync-agents --force-skill --skill https://github.com/owner/repo.git

# Install into <hub>/skills/ without syncing agent targets
sync-agents --skill-only --skill https://github.com/owner/repo.git
```

### 2. Author a New Local Skill

1. Create `<hub>/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`).
2. Run `sync-agents` to create managed symlinks, then `sync-agents --check`.

### 3. Remove a Skill

```bash
hub="$(sync-agents --print-dir --human)" && [ -n "$hub" ] && rm -rf "$hub/skills/<name>"
sync-agents
sync-agents --check
```

`sync-agents` prunes **only** symlinks recorded in the v2 ownership ledger whose current target still matches the recorded canonical path, leaving tool-owned directories (`~/.codex/skills/.system`, `~/.claude/skills/synced`) and independently created symlinks untouched.

### 4. Add, Override, Disable, or Remove an MCP Server

Create `<hub>/mcp/<server-name>/mcp.json`:

```json
{
  "mcp": {
    "transport": "stdio",
    "command": "/opt/homebrew/bin/example-mcp",
    "args": ["serve"],
    "env": {
      "LOG_LEVEL": "info"
    }
  }
}
```

Supported fields inside `"mcp"` (and per-agent overrides):
- **Stdio transport**: `"transport": "stdio"` (optional when `"command"` is set), `"command"` (string), `"args"` (string[]), `"env"` (Record<string, string>)
- **Remote transport**: `"transport": "http"` (streamable HTTP) or `"transport": "sse"` (**required** whenever `"url"` is set), `"url"` (string), `"headers"` (Record<string, string>)
- **Opt-out**: `"disabled": true` (evaluated *before* active transport checks; omits the server uniformly from that adapter)

Adapter transport support:
- `claude`: `stdio`, `http`, `sse`
- `codex`: `stdio`, `http` (rejects active `sse` unless disabled or overridden)
- `antigravity`: `stdio`, `http` (`serverUrl`) (rejects active `sse` unless disabled or overridden)
- `cursor`: `stdio`, `http`, `sse`
- `opencode`: `stdio` (`type: "local"`), `http`, `sse` (`type: "remote"`)

> **Tip:** Prefer absolute paths for `"command"` so GUI and non-login shells resolve binaries reliably.

**Per-agent overrides** (`antigravity`, `claude`, `codex`, `cursor`, `opencode`) apply in precedence order:
1. Base `mcp` in `<hub>/mcp/<name>/mcp.json`
2. Inline `"overrides": { "<agent>": { ... } }` in `<hub>/mcp/<name>/mcp.json`
3. Dedicated `<hub>/mcp/<name>/<agent>/mcp.json`

Switching transport families (`remote <-> stdio`) in an override automatically clears opposite-family inherited fields.

Then inspect, compile, and verify:
```bash
sync-agents --explain
sync-agents --dry-run
sync-agents
sync-agents --check
```

To **remove** a managed MCP server, delete `<hub>/mcp/<server-name>` and run `sync-agents && sync-agents --check`.

### 5. Edit Global Agent Instructions

Edit `<hub>/AGENTS.md` directly. Run `sync-agents --check` to confirm all managed symlinks remain valid and in sync.

### 6. Recovering or Migrating Legacy v1 State

- **Pending recovery** (after an interrupted run or state-storage I/O failure): run `sync-agents --explain` to inspect the pending journal, then run `sync-agents` once storage is healthy so Phase 0 reconciles the ledger automatically.
- **Legacy v1 `.mcp-managed.json`**:
  - Identical entries: run `sync-agents --adopt` once to record verified v2 ownership.
  - Retain a personal entry unowned: withdraw/rename the conflicting canonical `<hub>/mcp/<name>` directory, then run `sync-agents --disown-legacy <agent>:<name>`.

---

### 7. Project Mode (a repository's own `.agents/`)

`sync-agents --project` (from inside the repo, or `--dir <repo>`) syncs `<repo>/.agents/` into
`.mcp.json`, `.cursor/mcp.json`, `opencode.json`, `.codex/config.toml`, and `CLAUDE.md` /
`AGENTS.md` / `.claude/skills/<name>` symlinks, recording ownership in `.agents/sync.lock.json`.
Commit the lockfile with the outputs; `--project --check` then passes in any clone.

- It never touches the user's home configs; Antigravity is not written in project mode.
- A conflict (unmanaged or edited output) writes nothing: `--adopt` takes identical bytes,
  `--force` rewrites a file it wrote that was edited since.
- An invalid lockfile entry fails closed; after a lockfile merge conflict, run `--project --relock`.
- Plaintext secrets block. For `${vault:KEY}`, run the `sync-agents secret grant KEY --to SERVER
  --dir <repo>/.agents` command the summary prints. Reference: `docs/topics/project/README.md`.

## Flags & Conflict Handling

| Command | Behavior |
| --- | --- |
| `sync-agents` | Recover any pending journal (Phase 0), preflight-plan (Phase 1), and apply (Phase 2) |
| `sync-agents --dir <path>` | Target a different canonical hub directory (normalized to real absolute path) |
| `sync-agents --targets <csv>` | Restrict sync/check/dry-run/explain to specific selector(s): a target (`antigravity`, `claude`, `codex`, `cursor`, `opencode`) or `<target>:mcp` / `<target>:links`; excluded targets are never pruned. An explicit `--targets` list replaces `disabledTargets` for that run |
| `sync-agents --explain` | Show observed state, intended state, ownership basis, reason, and next step (read-only) |
| `sync-agents --human` | Print prose instead of JSON Lines (any command) |
| `sync-agents --schema` | Print the JSON Schema of every output message type |
| `sync-agents --dry-run` (`-n`) | Show planned actions (`op` lines with `phase: "plan"`) without modifying final destinations, state, journals, or locks |
| `sync-agents --check` | Exit `0` iff the active targets, ownership ledger, and recovery state all require zero work (excluded targets and domains are not checked; a pending recovery journal always is) |
| `sync-agents --adopt` | Adopt unmanaged identical symlinks/MCP entries or strictly equivalent files/dirs (checks `.git`, bytes, mode bits, owner/group, raw xattr values, ACLs) |
| `sync-agents --force-skill` | Allow `--skill` to replace differing canonical skill(s) ONLY |
| `sync-agents --force` (`-f`) | Allow replacing differing canonical skills, unmanaged/modified symlinks, and differing/disabled unmanaged MCP entries |
| `sync-agents --disown-legacy <agent>:<name>` | Retire an unverified legacy v1 claim without modifying the target config. That agent's MCP domain must be in scope, and it cannot be combined with `--skill-only`; otherwise exit `2` |

**Safety rule on conflicts:** `sync-agents` fails closed before Phase 2 when any conflict is detected (reporting any Phase 0 recovery separately). Always run `sync-agents --explain` before using `--adopt`, `--force-skill`, or `--force`.

### Scoping and opting out of targets

- **Selectors:** a target name (`antigravity`, `claude`, `codex`, `cursor`, `opencode`) means both of its domains; `<name>:mcp` means only its MCP config file; `<name>:links` means only its rules and skill symlinks.
- **`disabledTargets`** lives in `${XDG_CONFIG_HOME:-~/.config}/agent-hub/config.json` as an array of selectors: `{ "disabledTargets": ["cursor", "opencode:mcp"] }`. An unknown selector or non-array value makes every run exit `1`.
- **`--targets <csv>`** / **`--targets=<csv>`** picks selectors for one run (sync, `--check`, `--dry-run`, `--explain`); an unknown selector exits `2`. Give it once; a repeated `--targets` exits `2`. It **replaces** `disabledTargets` for that run.
- **Excluded targets are never planned.** What agent-hub placed there earlier stays; hub removals stop reaching them until the target is active again. (Phase 0 recovery still finishes agent-hub's own interrupted write on any target.) `--check` covers active targets plus any pending recovery journal. When a user asks to stop syncing a tool, add it to `disabledTargets`; do not delete its links or entries unless they ask for that too.

### Strict JSON refusals

The four JSON adapters (`antigravity`, `claude`, `cursor`, `opencode`) refuse a target config when a `.jsonc` sibling exists (e.g. `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc`), or when the `.json` has comments, trailing commas, or a key repeated in one object. **A refusal stops the whole run**: no Phase 2 target or ledger change is applied. The error names the target, the resolved `config.json` path, and the remedy.

When you hit one: tell the user which file was refused and why, then offer to add `"<target>:mcp"` to `disabledTargets`, which leaves only that tool's MCP config alone and keeps its rules and skills syncing. **Never edit, rename, reformat, or strip comments from the user's `.jsonc`/`.json` yourself, and never reach for `--force`, unless the user explicitly asks.** The same goes for a `conflict` line about a personal MCP entry in one tool's config: excluding that target is the non-destructive way to sync the rest.
