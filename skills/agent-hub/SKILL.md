---
name: agent-hub
description: Manage local AI coding agent configuration through a canonical agents hub directory (default ~/.agents/) and the sync-agents CLI. Use whenever the user asks to install, update, create, or remove an agent skill; add, override, disable, or remove an MCP server; edit global agent instructions; or sync/check drift across Claude Code, Codex, and Antigravity.
---

# Agent Hub (`sync-agents`)

Shared configuration for local AI coding agents lives in a canonical hub directory (default **`~/.agents/`**, configurable via `--dir`, `$AGENTS_DIR`, or `~/.config/agent-hub/config.json`) and is synchronized across **Claude Code**, **Codex**, **Antigravity**, **OpenCode**, and **Cursor** (global Cursor rules unverified/experimental) by running **`sync-agents`**.

> **Note:** **Gemini CLI** (`~/.gemini/settings.json`) is not currently supported by the MCP compiler. The `antigravity` adapter targets Antigravity's `~/.gemini/config/mcp_config.json`.

Run `sync-agents --print-dir` to confirm the canonical resolved hub path.

## Golden Rule

1. **Always edit inside the canonical hub (`~/.agents/`)** — never edit per-agent synced targets directly:
   - Instructions symlinks: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `~/.config/opencode/AGENTS.md`, `~/.cursor/AGENTS.md` *(unverified)*
   - Per-skill symlinks: `~/.claude/skills/<name>`, `~/.codex/skills/<name>`, `~/.gemini/skills/<name>`, `~/.config/opencode/skills/<name>`, `~/.cursor/skills/<name>`
   - Compiled MCP entries: `~/.gemini/config/mcp_config.json` (`antigravity`), `mcpServers` in `~/.claude.json` (`claude`), `[mcp_servers.*]` in `~/.codex/config.toml` (`codex`), `mcpServers` in `~/.cursor/mcp.json` (`cursor`), `mcp` in `~/.config/opencode/opencode.json` (`opencode`)
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
rm -rf "$(sync-agents --print-dir)/skills/<name>"
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

## Flags & Conflict Handling

| Command | Behavior |
| --- | --- |
| `sync-agents` | Recover any pending journal (Phase 0), preflight-plan (Phase 1), and apply (Phase 2) |
| `sync-agents --dir <path>` | Target a different canonical hub directory (normalized to real absolute path) |
| `sync-agents --targets <csv>` | Restrict sync/check to specific adapter(s) (`antigravity`, `claude`, `codex`, `cursor`, `opencode`); untargeted adapters are never pruned. An explicit `--targets` list replaces `disabledTargets` for that run |
| `sync-agents --explain` | Show observed state, intended state, ownership basis, reason, and next step (read-only) |
| `sync-agents --dry-run` (`-n`) | Show `[plan]` actions without modifying final destinations, state, journals, or locks |
| `sync-agents --check` | Exit `0` iff targets, ownership ledger, and recovery state all require zero work |
| `sync-agents --adopt` | Adopt unmanaged identical symlinks/MCP entries or strictly equivalent files/dirs (checks `.git`, bytes, mode bits, owner/group, raw xattr values, ACLs) |
| `sync-agents --force-skill` | Allow `--skill` to replace differing canonical skill(s) ONLY |
| `sync-agents --force` (`-f`) | Allow replacing differing canonical skills, unmanaged/modified symlinks, and differing/disabled unmanaged MCP entries |
| `sync-agents --disown-legacy <agent>:<name>` | Retire an unverified legacy v1 claim without modifying the target config |

**Safety rule on conflicts:** `sync-agents` fails closed before Phase 2 when any conflict is detected (reporting any Phase 0 recovery separately). Always run `sync-agents --explain` before using `--adopt`, `--force-skill`, or `--force`.
