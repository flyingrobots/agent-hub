# agent-hub

Maintain global instructions (`AGENTS.md`), skills (`skills/`), and MCP server definitions (`mcp/`) in **one canonical directory** (default `~/.agents/`) and project them predictably into each local AI coding agent's configuration.

Keep your personal `~/.agents/` directory in its own private git repo while installing the `agent-hub` runtime cleanly into `~/.agent-hub/` (decoupled from your source checkout) and storing machine-local ownership state under XDG state (`~/.local/state/agent-hub/`).

---

## Supported Targets & Status

| Target | Rules | Skills | MCP Config | Notes |
| --- | --- | --- | --- | --- |
| **Claude Code** | `~/.claude/CLAUDE.md` | `~/.claude/skills/<name>` | `~/.claude.json` (`mcpServers`) | Supports `stdio`, `http` (streamable HTTP), `sse` |
| **Codex** | `~/.codex/AGENTS.md` | `~/.codex/skills/<name>` | `~/.codex/config.toml` (`[mcp_servers.*]`) | Supports `stdio`, `http` (streamable HTTP); rejects active `sse` |
| **Antigravity** | `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md` | `~/.gemini/skills/<name>` | `~/.gemini/config/mcp_config.json` (`mcpServers`) | Override key: `antigravity`. Supports `stdio`, `http` (`serverUrl`); rejects active `sse` |
| **Cursor** | `~/.cursor/AGENTS.md` *(unverified / experimental)* | `~/.cursor/skills/<name>` | `~/.cursor/mcp.json` (`mcpServers`) | Supports `stdio`, `http`, `sse`. Global Cursor rules are settings-configured; `~/.cursor/AGENTS.md` effect is unverified |
| **OpenCode** | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/skills/<name>` | `~/.config/opencode/opencode.json` (`mcp`) | Supports `stdio` (`type: "local"`), `http`/`sse` (`type: "remote"`). Writes servers directly under `mcp.<name>` with `enabled`, a layout OpenCode's schema still accepts but marks deprecated in favor of `mcp.servers` (tracked in flyingrobots/agent-hub#13). Strict JSON only — `.jsonc` files with comments are refused until a comment-preserving editor is added |

> **Strict JSON / JSONC notice:** All JSON MCP adapters (`antigravity`, `claude`, `cursor`, `opencode`) parse target configs strictly via `JSON.parse` and refuse to modify a target config whenever a `.jsonc` sibling exists (e.g., `opencode.jsonc`), whether or not the `.json` file also exists. They also refuse a config that contains comments, trailing commas, or the same key twice in one object (where `JSON.parse` would silently keep only the last value). Commented JSONC files are unsupported until a comment-preserving editor is added.
>
> **A refusal stops the whole run.** Every active target is planned before anything is written, so one refused config means no Phase 2 target or ledger change is applied in that run (Phase 0 recovery of an earlier interrupted write may still complete), and `--check` fails too. The error names the target and the remedy: add `"<target>:mcp"` to `disabledTargets` (see [Choosing targets](#choosing-targets)) to leave only that tool's MCP config alone while its rules and skill links keep syncing. Do not strip comments from a tool's own config just to make `sync-agents` run.

> **Important:** Structural synchronization verifies filesystem links, serialized JSON/TOML, and ownership state — it does not prove that a downstream agent application loaded and honored the configuration at runtime.

---

## Prerequisites & First-Use Setup

### Prerequisites

- **Bun** (required upfront for `sync-agents`; tested on Bun `1.4.2`; `--help` and `--print-dir` work without Bun)
- **Git**, **`unzip`**, **`tar`** (required when installing skills from git URLs, `.bundle`, `.zip`/`.skill`, or tarballs)
- Supported platforms: **macOS** and **Linux** (uses OS advisory `flock(2)` for cooperating writer exclusion)

### 1. Create your canonical hub (first time)

```bash
mkdir -p ~/.agents/skills ~/.agents/mcp
printf '# Global Agent Instructions\n' > ~/.agents/AGENTS.md
```

### 2. Install the `agent-hub` runtime

```bash
git clone https://github.com/flyingrobots/agent-hub.git
cd agent-hub
./install.sh
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.zshrc or ~/.bashrc
```

What `./install.sh` does (and does **not** do):
- Copies the runtime into `~/.agent-hub/` with an `.agent-hub-runtime` marker and symlinks `~/.local/bin/sync-agents`.
- **Never supplies global `--force`**. If `~/.agents/skills/agent-hub` already exists and differs from the bundled copy, it is **preserved** and a conflict is reported. Pass `./install.sh --force-skill` to replace *only* the bundled `agent-hub` skill (never authorizing MCP or symlink replacement), or `--no-skill` / `--no-sync` to skip skill installation or target sync.
- **Prefix & shim guards**: Refuses to replace `/`, `$HOME`, any prefix overlapping your hub directory, any populated `--prefix` lacking a valid `.agent-hub-runtime` marker (or verified baseline checksums), or an unrecognized file at `~/.local/bin/sync-agents` unless explicitly overridden (`--replace-runtime`, which moves the previous prefix aside as a backup, or `--replace-bin`).

### 3. Configure your hub directory

`sync-agents` resolves and canonicalizes the hub path to a real absolute path in precedence order:

1. `--dir <path>` CLI flag
2. `$AGENTS_DIR` environment variable
3. `${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub/config.json` (`"agentsDir"`)
4. Default: `~/.agents`

The same `config.json` also holds `"disabledTargets"`; see [Choosing targets](#choosing-targets). A `config.json` that is not a JSON object, or whose `disabledTargets` is invalid, makes every sync run exit `1` with the reason.

### Choosing targets

Every target whose root directory exists (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor`, `~/.config/opencode`) is synced by default.

Each target has two sync domains: **`links`** (its rules file and skill symlinks) and **`mcp`** (its MCP config file). A selector is a target name (`antigravity`, `claude`, `codex`, `cursor`, `opencode`), meaning both domains, or a name with a domain suffix such as `opencode:mcp` or `cursor:links`.

- **`disabledTargets`** in `${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub/config.json` is an array of selectors to leave out by default:

  ```json
  { "agentsDir": "~/.agents", "disabledTargets": ["cursor", "opencode:mcp"] }
  ```

  This example leaves Cursor out entirely, and syncs OpenCode's rules and skills but not `opencode.json` (useful if you keep an `opencode.jsonc`). An unknown selector or a non-array value makes the run exit `1`.
- **`--targets <csv>`** (or `--targets=<csv>`) picks the selectors for one run of sync, `--check`, `--dry-run`, or `--explain`, e.g. `--targets claude,opencode:links`. An unknown selector exits `2`. An explicit `--targets` list **replaces** `disabledTargets` for that run, so `--targets cursor` acts on Cursor even when `"cursor"` is disabled.
- **Excluded targets are left as they are.** A run never plans changes for an excluded target or domain: symlinks and MCP entries that `sync-agents` placed earlier stay put, and hub changes (including removed servers) stop reaching them. The one exception is Phase 0 recovery, which always finishes `sync-agents`' own interrupted write, whatever the target. `--check` reports drift for active targets only, plus any pending recovery journal. When a target is enabled again, the next run catches it up, including any prunes it missed.

### Upgrading from a three-target version

Earlier versions synced MCP servers only to Claude, Codex, and Antigravity, though they already linked rules and skills into `~/.cursor` and `~/.config/opencode`. After upgrading, the first unscoped run also writes your hub's MCP servers into `~/.cursor/mcp.json` and `~/.config/opencode/opencode.json`, and `--check` reports that as pending work until it happens. That run is refused, with no Phase 2 change applied, if either file has a personal server with the same name as a hub server, or if either config is refused under the strict JSON rules above (for example an `opencode.jsonc` exists). To keep the old behavior exactly (links into both tools, MCP only for the original three), set `"disabledTargets": ["cursor:mcp", "opencode:mcp"]` before the first run.

---

## Canonical Hub Layout

```text
~/.agents/                      # Your personal config (private git repo; no machine state stored here)
├── AGENTS.md                   # Shared global instructions
├── skills/
│   └── <skill-name>/
│       └── SKILL.md            # Plus optional references/, scripts/, assets
└── mcp/
    └── <server-name>/
        ├── mcp.json            # Canonical MCP server spec (+ optional inline overrides)
        └── <agent>/mcp.json    # Optional per-agent override (antigravity | claude | codex | cursor | opencode)
```

### Canonical `mcp.json` Format & Transport Semantics

```json
{
  "mcp": {
    "transport": "stdio",
    "command": "/opt/homebrew/bin/shadcn",
    "args": ["mcp"]
  },
  "overrides": {
    "codex": {
      "env": { "MODE": "codex" }
    }
  }
}
```

Remote server example (SSE enabled for Claude, Cursor, and OpenCode; omitted for Antigravity and Codex, which do not support SSE):

```json
{
  "mcp": {
    "transport": "sse",
    "url": "https://example.com/mcp/sse",
    "headers": { "Authorization": "Bearer ${TOKEN}" }
  },
  "overrides": {
    "antigravity": { "disabled": true },
    "codex": { "disabled": true }
  }
}
```

Rules:
- **Explicit transport**: `command` infers `"transport": "stdio"` if omitted. A remote `url` **must** explicitly set `"transport": "http"` (streamable HTTP) or `"transport": "sse"`.
- **Disabled-first precedence**: `"disabled": true` is evaluated *before* active transport validation and omits the server uniformly from that adapter (`antigravity`, `claude`, `codex`, `cursor`, or `opencode`).
- **Transport-family switching**: Overriding a remote base with a `stdio` override (or vice versa) cleanly clears opposite-family inherited fields (`url`/`headers` vs `command`/`args`/`env`).
- **Override precedence**: base `mcp.json` -> inline `overrides.<agent>` -> `<agent>/mcp.json`. Legacy `gemini` override keys/directories fail with a migration message pointing to `antigravity`.

---

## Usage

```bash
# Sync instructions, skills, and MCP configs
sync-agents

# Restrict sync/check/dry-run/explain to specific target(s) (excluded targets are never pruned)
sync-agents --targets claude,codex

# Opt out of specific targets by default in ~/.config/agent-hub/config.json:
# { "agentsDir": "~/.agents", "disabledTargets": ["cursor", "opencode"] }
# Precedence: an explicit --targets list replaces disabledTargets for that run, so
# `--targets cursor` acts on Cursor even when "cursor" is listed in disabledTargets.

# Inspect observed state, intended state, ownership basis, and reasons (read-only)
sync-agents --explain

# Preview planned changes (leaves final hub, targets, state, journals, and locks untouched)
sync-agents --dry-run

# Verify targets, ownership ledger, and recovery state are completely clean (exits 1 on any drift)
sync-agents --check

# Install a skill from a directory, Git URL, .bundle, .zip/.skill, or tarball
sync-agents --skill https://github.com/owner/repo.git

# Update an already-installed skill ONLY (never forces MCP or symlink replacement)
sync-agents --force-skill --skill https://github.com/owner/repo.git

# Adopt unmanaged identical symlinks, MCP entries, or strictly equivalent files/dirs
sync-agents --adopt

# Retire an unverified legacy v1 .mcp-managed.json claim while retaining a personal entry
sync-agents --disown-legacy claude:personal-server
```

> **Dry-run note:** `--dry-run`, `--check`, and `--explain` never modify final destinations, ownership state, journals, or lock files. When `--dry-run` is combined with `--skill <git-url|archive>`, the source is unpacked into a temporary directory under `$TMPDIR` to inspect `SKILL.md` and cleaned up on exit.

---

## Safety, Ownership & Recovery Model

### Explicit Ownership Ledger (XDG State)

Machine-local ownership records live under `${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub/` (never inside your git-tracked `~/.agents/`):
- `state-<hub-hash>.json` — v2 ownership ledger with monotonic `generation`, tracking every managed symlink (`target`, `basis`) and managed MCP entry (`configPath`, content `digest`, `basis`).
- `journal-<hub-hash>.json` — active write-ahead recovery journal present only while a target mutation is in flight.
- `apply.lock` — persistent inode locked via OS-held advisory `flock(2)` during `apply` (never unlinked; released automatically by the kernel on process exit or `SIGKILL`).

Key safety guarantees:
- **No inferred ownership**: A symlink's existence, a hub path prefix, or a disabled canonical MCP entry never grants ownership. Unmanaged entries are preserved and reported as conflicts.
- **Strict adoption-equivalence contract (`--adopt`)**: Replacing a non-symlink file or directory with a symlink requires exact equality across **all** entries (including `.git`, dotfiles, and empty directories), object kinds (refusing FIFOs, sockets, and device nodes), file bytes, full permission/special mode bits (`mode & 0o7777`), `uid`/`gid`, hardlink guard (`nlink === 1`), literal symlink targets (refusing escaping relative symlinks), and extended attributes (names **and raw byte values**) + ACLs on macOS (and on Linux when `getfattr`/`getfacl` are installed; when absent on Linux, xattrs/ACLs are outside host verification). Explicitly non-preserved properties under `--adopt`: file timestamps (`atime`/`mtime`/`ctime`/`birthtime`) and inode/dirent identity.
- **TOML-aware Codex editing + semantic guard**: Codex `config.toml` edits use a TOML 1.0 lexical scanner (preserving multiline strings, comments, and unrelated tables), refuse unsupported inline/dotted `mcp_servers` representations before writing, and verify deep semantic equality of every unrelated parsed value before touching disk.
- **Preflight & freshness verification**: Phase 1 validates everything before Phase 2 starts. A preflight conflict causes no new Phase 2 target or ledger changes (any Phase 0 recovery performed earlier in the run is reported separately). Immediately before each Phase 2 mutation, the live snapshot (contents, mode, uid/gid, or full tree equivalence digest) is re-verified against the planned snapshot; drifted targets are preserved and the stale write is refused.
- **Write-ahead recovery & durability scope**: Every target mutation writes a recovery journal before modifying the target and clears it only after the corresponding ledger update completes. On restart, Phase 0 reconciles interrupted operations (including target-written/state-unsaved and mid-swap directory replacements) or stops safely preserving evidence if the target changed ambiguously. **Scope:** Intended recovery guarantees cover **process interruption and ordinary I/O failures**; machine crash / power-loss durability is unverified and outside this guarantee.
- **Concurrency scope**: Cooperating `sync-agents` writers (even across different hubs) are serialized by `flock(2)`. Against non-cooperating external agent applications, snapshot verification prevents applying stale plans, while POSIX check-then-rename still leaves an open window against simultaneous external writes.

### Migrating from Legacy v1 `.mcp-managed.json`

Existing `<hub>/.mcp-managed.json` (v1) manifests are treated conservatively as **unverified provenance**:
1. **Identical existing entries**: Run `sync-agents --adopt` once to record verified v2 ownership in XDG state without rewriting configs.
2. **Absent targets** (disabled or removed): Automatically retired into v2 state on the next ordinary `sync-agents` run (reported as ledger-only drift by `--check` until applied).
3. **Retaining a personal entry without ownership**: Withdraw or rename the conflicting canonical `<hub>/mcp/<name>` directory (note: this affects all adapters), then run `sync-agents --disown-legacy <agent>:<name>` to retire the legacy claim without touching your target config.
4. **Replacing or deleting**: Pass `--force` explicitly after inspecting the conflict.

---

## Development & Tests

```bash
bun test
```

Promote reviewed changes from your dev checkout to `~/.agent-hub/`:

```bash
./install.sh
```

## License

[Apache-2.0](LICENSE)
