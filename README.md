# agent-hub

Manage global instructions (`AGENTS.md`), skills (`skills/`), and MCP server definitions (`mcp/`) in **one canonical directory** (default `~/.agents/`) and synchronize them cleanly across local AI coding agents:

- **Claude Code** (`~/.claude/CLAUDE.md`, `~/.claude/skills/<name>`, `~/.claude.json` `mcpServers`)
- **Codex** (`~/.codex/AGENTS.md`, `~/.codex/skills/<name>`, `~/.codex/config.toml` `[mcp_servers.*]`)
- **Antigravity / Gemini** (`~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `~/.gemini/skills/<name>`, `~/.gemini/config/mcp_config.json`)
- **OpenCode & Cursor** (rules + skills symlinks when installed)

Keep your personal `~/.agents/` directory in its own private dotfiles repo while installing `agent-hub` cleanly into `~/.agent-hub/` (isolated from your git checkout).

---

## Quick Start

```bash
git clone https://github.com/flyingrobots/agent-hub.git
cd agent-hub
./install.sh
```

`install.sh` copies the runtime to `~/.agent-hub/`, symlinks `~/.local/bin/sync-agents`, and installs the bundled `agent-hub` meta-skill into your hub directory if it already exists.

### Configure Your Hub Directory

`sync-agents` resolves the hub directory in precedence order:

1. `--dir <path>` CLI flag
2. `$AGENTS_DIR` environment variable
3. `~/.config/agent-hub/config.json`:
   ```json
   {
     "agentsDir": "~/.agents"
   }
   ```
4. Default: `~/.agents`

---

## Canonical Hub Layout

```text
~/.agents/                      # Your personal config (great as a private git repo)
├── AGENTS.md                   # Shared global instructions
├── skills/
│   └── <skill-name>/
│       └── SKILL.md            # Plus optional references/, scripts/, assets
└── mcp/
    └── <server-name>/
        ├── mcp.json            # Canonical MCP server spec (+ optional inline overrides)
        └── <agent>/mcp.json    # Optional per-agent override (gemini | claude | codex)
```

### Canonical `mcp.json` Format

```json
{
  "mcp": {
    "command": "/opt/homebrew/bin/shadcn",
    "args": ["mcp"]
  },
  "overrides": {
    "codex": {
      "disabled": false
    }
  }
}
```

Supported fields: `command`, `args`, `env`, `url`, `headers`, `disabled`.

---

## Usage

```bash
# Sync instructions, skills, and MCP configs
sync-agents

# Install a skill from a Git URL, local directory, .bundle, .zip/.skill, or tarball
sync-agents --skill https://github.com/meodai/skill.color-expert.git

# Update an already-installed skill
sync-agents --force --skill https://github.com/meodai/skill.color-expert.git

# Preview changes without modifying disk
sync-agents --dry-run

# Verify everything is in sync (exits 1 on drift or conflicts)
sync-agents --check

# Adopt identical existing files/MCP entries as managed
sync-agents --adopt
```

---

## Safety Properties

- **Per-skill symlinks only** — never replaces an entire `skills/` directory, preserving tool-owned directories like `~/.codex/skills/.system`, `~/.claude/skills/synced`, and `~/.claude/skills/.trash`.
- **Surgical MCP edits** — updates only managed entries in `~/.claude.json` and `~/.codex/config.toml`, preserving all unrelated sections and existing file permissions (such as `0600`).
- **Fail-closed on conflicts** — refuses to overwrite unmanaged files or differing configs unless `--adopt` (when byte-identical) or `--force` is explicitly passed.
- **Safe pruning** — removes stale symlinks and deleted MCP servers only when they were previously managed by `sync-agents`.

---

## Development & Tests

```bash
bun test
```

When you are ready to promote changes from your dev checkout to `~/.agent-hub/`:

```bash
./install.sh
```

## License

[Apache-2.0](LICENSE)
