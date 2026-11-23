# agent-hub

Keep global instructions (`AGENTS.md`), skills (`skills/`) and MCP server definitions (`mcp/`) in
**one canonical directory** (default `~/.agents/`) and project them predictably into each local AI
coding agent's configuration with `sync-agents`.

Your hub can live in its own private git repository. The runtime installs separately into
`~/.agent-hub/`, and machine-local ownership state lives under XDG state
(`~/.local/state/agent-hub/`), so nothing machine-specific is written into the hub.

| Target | Rules and skills | MCP config |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md`, `~/.claude/skills/` | `~/.claude.json` |
| Codex | `~/.codex/AGENTS.md`, `~/.codex/skills/` | `~/.codex/config.toml` |
| Antigravity | `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `~/.gemini/skills/` | `~/.gemini/config/mcp_config.json` |
| Cursor | `~/.cursor/AGENTS.md` (effect unverified), `~/.cursor/skills/` | `~/.cursor/mcp.json` |
| OpenCode | `~/.config/opencode/AGENTS.md`, `~/.config/opencode/skills/` | `~/.config/opencode/opencode.json` |

`sync-agents` only changes what its ownership ledger says it owns, plans every change before
writing any, and recovers from interruption. The full model is in the
[documentation](docs/README.md).

## Install

Prerequisites:

- **Bun** to run `sync-agents` (CI uses Bun `1.4.5`). `--help` and `--print-dir` work without it.
- **Git**, **`unzip`** and **`tar`** to install skills from Git URLs, bundles or archives.
- **macOS** or **Linux**.

Create a hub the first time:

```bash
mkdir -p ~/.agents/skills ~/.agents/mcp
printf '# Global Agent Instructions\n' > ~/.agents/AGENTS.md
```

Install the runtime:

```bash
git clone https://github.com/flyingrobots/agent-hub.git
cd agent-hub
./install.sh
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

`install.sh` copies the runtime into `~/.agent-hub/` (marked with `.agent-hub-runtime`), links
`~/.local/bin/sync-agents`, installs the bundled `agent-hub` skill into the hub, and syncs.

- It never passes `--force`. If `~/.agents/skills/agent-hub` already exists and differs, it is
  kept and reported. `--force-skill` replaces only that skill; `--no-skill` and `--no-sync` skip
  those steps.
- It refuses to replace `/`, `$HOME`, a prefix overlapping the hub, a populated prefix without a
  valid runtime marker, or an unrecognized file at `~/.local/bin/sync-agents`, unless told to
  with `--replace-runtime` (which moves the old prefix aside) or `--replace-bin`.

## Use

```bash
sync-agents                         # sync instructions, skills and MCP servers
sync-agents --check                 # exit 0 if nothing needs doing, 1 if anything does
sync-agents --dry-run               # show what a sync would change
sync-agents --explain               # show observed state, intended state and why, per object
sync-agents --targets claude,codex  # act on some targets only (others are never pruned)
sync-agents --skill https://github.com/owner/repo.git   # install a skill, then sync
sync-agents --adopt                 # record identical unmanaged entries as owned
sync-agents --print-dir             # print the resolved hub directory
```

Where to go next:

- What is written where, choosing targets with `--targets` and `disabledTargets`, and upgrading
  from a three-target version: [Sync and targets](docs/topics/sync/README.md).
- The canonical `mcp.json` format, what each target receives, and why a config can be refused:
  [MCP servers](docs/topics/mcp/README.md).
- Ownership, adoption, recovery, locking and migrating legacy v1 state:
  [Ownership and recovery](docs/topics/ownership/README.md).

## Development

```bash
bash -n bin/sync-agents install.sh && bun run typecheck && bun test
```

Run `./install.sh` from a checkout to promote it to `~/.agent-hub/`. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE)
