---
name: agent-hub
description: Manage local AI coding agent configuration through a canonical agents hub directory (default ~/.agents/) and the sync-agents CLI. Use whenever the user asks to install, update, create, or remove an agent skill; add, override, disable, or remove an MCP server; edit global agent instructions; or sync/check drift across Claude Code, Codex, and Antigravity/Gemini.
---

# Agent Hub (`sync-agents`)

Shared configuration for local AI coding agents lives in a canonical hub directory (default **`~/.agents/`**, configurable via `--dir`, `$AGENTS_DIR`, or `~/.config/agent-hub/config.json`) and is synchronized across **Claude Code**, **Codex**, **Antigravity / Gemini**, **OpenCode**, and **Cursor** by running **`sync-agents`**.

Run `sync-agents --print-dir` if you need to confirm the active hub path.

## Golden Rule

1. **Always edit inside the canonical hub (`~/.agents/`)** — never edit per-agent synced targets directly:
   - Instructions symlinks: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`
   - Per-skill symlinks: `~/.claude/skills/<name>`, `~/.codex/skills/<name>`, `~/.gemini/skills/<name>`
   - Compiled MCP entries: `~/.gemini/config/mcp_config.json`, `mcpServers` in `~/.claude.json`, `[mcp_servers.*]` in `~/.codex/config.toml`
2. **Always finish with `sync-agents` and verify with `sync-agents --check`.**

---

## Canonical Hub Layout

| Path | Purpose | Sync Mechanism |
| --- | --- | --- |
| `<hub>/AGENTS.md` | Shared global instructions (repo-level `AGENTS.md` / `CLAUDE.md` still take precedence) | Symlinked to each installed agent's rules file |
| `<hub>/skills/<name>/SKILL.md` | Canonical skill directories (with optional `references/`, `scripts/`, assets) | Per-skill symlinks into each agent's `skills/` dir |
| `<hub>/mcp/<name>/mcp.json` | Canonical MCP server definition (+ optional inline `overrides.<agent>` or `<agent>/mcp.json`) | Compiled by `sync-agents` into each agent's native MCP config format |
| `<hub>/.mcp-managed.json` | Machine-local state manifest tracking managed MCP servers | Managed automatically — do not hand-edit (keep in `.gitignore`) |

---

## Common Workflows

### 1. Install or Update a Skill

`sync-agents --skill <src>` accepts:
- **Git repository URL** (`https://...`, `http://...`, `ssh://...`, `git://...`, `git@...`) — shallow-cloned, `.git/` stripped
- **Local directory** containing `SKILL.md` (or `skills/<name>/SKILL.md`)
- **Git `.bundle`**, **`.zip` / `.skill`**, or **tarball** (`.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`)

The skill name is read from `name:` in `SKILL.md` YAML frontmatter (falling back to the directory/repo name).

```bash
# Preview first when unsure
sync-agents --dry-run --skill https://github.com/owner/repo.git

# Install and sync across all local agents
sync-agents --skill https://github.com/owner/repo.git

# Update an already-installed skill whose contents changed
sync-agents --force --skill https://github.com/owner/repo.git
```

Multiple `--skill` flags can be passed in one command.

### 2. Author a New Local Skill

1. Create `<hub>/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`).
2. Run `sync-agents` to symlink it into every installed agent, then `sync-agents --check`.

### 3. Remove a Skill

```bash
rm -rf "$(sync-agents --print-dir)/skills/<name>"
sync-agents
sync-agents --check
```

`sync-agents` automatically prunes stale symlinks pointing into `<hub>/skills/` while leaving tool-owned directories (such as `~/.codex/skills/.system`, `~/.claude/skills/synced`, and `~/.claude/skills/.trash`) untouched.

### 4. Add, Override, Disable, or Remove an MCP Server

Create `<hub>/mcp/<server-name>/mcp.json`:

```json
{
  "mcp": {
    "command": "/opt/homebrew/bin/example-mcp",
    "args": ["serve"],
    "env": {
      "LOG_LEVEL": "info"
    }
  }
}
```

Supported fields inside `"mcp"` (and overrides):
- Stdio transport: `"command"` (string), `"args"` (string[]), `"env"` (Record<string, string>)
- Remote HTTP/SSE transport: `"url"` (string), `"headers"` (Record<string, string>)
- Opt-out: `"disabled": true` (omits the server from that agent)

> **Tip:** Prefer absolute paths for `"command"` so GUI and non-login shells resolve binaries reliably.

**Per-agent overrides** (`gemini`, `claude`, `codex`) apply in precedence order:
1. Base `mcp` in `<hub>/mcp/<name>/mcp.json`
2. Inline `"overrides": { "<agent>": { ... } }` in `<hub>/mcp/<name>/mcp.json`
3. Dedicated `<hub>/mcp/<name>/<agent>/mcp.json`

Then compile and verify:
```bash
sync-agents --dry-run
sync-agents
sync-agents --check
```

To **remove** a managed MCP server, delete `<hub>/mcp/<server-name>` and run `sync-agents && sync-agents --check`. Unrelated config sections and `0600` file permissions are preserved automatically.

### 5. Edit Global Agent Instructions

Edit `<hub>/AGENTS.md` directly. Because each installed agent's global instructions file is symlinked to `<hub>/AGENTS.md`, changes propagate immediately. Run `sync-agents --check` to confirm all symlinks remain healthy.

---

## Flags & Conflict Handling

| Command | Behavior |
| --- | --- |
| `sync-agents` | Sync instructions, skills, and MCP configs across all installed agents |
| `sync-agents --dir <path>` | Temporarily target a different canonical hub directory |
| `sync-agents --dry-run` (`-n`) | Show `[plan]` actions without touching the filesystem |
| `sync-agents --check` | Exit `0` if everything is in sync, `1` on any drift or conflict |
| `sync-agents --adopt` | Replace an unmanaged file/dir/MCP entry only when byte-identical to canonical |
| `sync-agents --force` (`-f`) | Allow overwriting a differing canonical skill (`--skill`) or differing unmanaged MCP entry |

**Safety rule on conflicts:** `sync-agents` fails closed when an unmanaged file or differing config already exists. Always inspect or diff the conflict before passing `--adopt` or `--force`.
