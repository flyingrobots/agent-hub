# Sync and targets

`sync-agents` projects one canonical hub directory into the configuration of each local AI
coding agent it supports. This page is the reference for what it writes, where, and how a run is
scoped. Contracts are tracked in [test-plan.md](test-plan.md).

## What a run does

A run has three phases:

1. **Phase 0, recovery.** If an earlier run was interrupted mid-write, finish or safely stop that
   write first. See [Ownership and recovery](../ownership/README.md#write-ahead-recovery).
2. **Phase 1, preflight.** Plan every change for every active target, and stop with no writes if
   anything conflicts or is refused.
3. **Phase 2, apply.** Write each planned change, journaled and re-verified against the planned
   snapshot.

`--dry-run` (`-n`), `--check` and `--explain` run Phase 1 only. They never modify targets, the
ownership ledger, journals or the lock file. If a recovery journal is pending, they report it
instead of a plan: `--check` exits `1`, and the next real run handles it in Phase 0.

| Command | Result |
| --- | --- |
| `sync-agents` | Recover, plan, apply |
| `sync-agents --dry-run` | Print a planned `op` line for each change a sync would make, then a `planned` summary |
| `sync-agents --check` | Exit `0` if nothing needs doing, `1` if anything does |
| `sync-agents --explain` | Print observed state, intended state, ownership basis, reason and next step per object |

A conflict or refusal exits `1`. A usage error, such as an unknown flag or an unknown
`--targets` selector, exits `2`.

## The hub

The hub directory is resolved, in order, from:

1. `--dir <path>`
2. `$AGENTS_DIR`
3. `"agentsDir"` in `${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub/config.json`
4. `~/.agents`

The path is canonicalized to a real absolute path, so links written from any working directory
point at the same place. `sync-agents --print-dir --human` prints the resolved hub (without `--human`, as a JSON line).

```text
<hub>/
├── AGENTS.md                  # Shared global instructions
├── skills/<name>/SKILL.md     # One directory per skill
└── mcp/<server>/mcp.json      # One directory per MCP server; see the MCP topic
```

## Targets

| Target | Rules link | Skill links | MCP config |
| --- | --- | --- | --- |
| `claude` | `~/.claude/CLAUDE.md` | `~/.claude/skills/<name>` | `~/.claude.json` (`mcpServers`) |
| `codex` | `~/.codex/AGENTS.md` | `~/.codex/skills/<name>` | `~/.codex/config.toml` (`[mcp_servers.*]`) |
| `antigravity` | `~/.gemini/GEMINI.md` and `~/.gemini/config/AGENTS.md` | `~/.gemini/skills/<name>` | `~/.gemini/config/mcp_config.json` (`mcpServers`) |
| `cursor` | `~/.cursor/AGENTS.md` | `~/.cursor/skills/<name>` | `~/.cursor/mcp.json` (`mcpServers`) |
| `opencode` | `<oc>/AGENTS.md` | `<oc>/skills/<name>` | `<oc>/opencode.json` (`mcp.servers`) |

A target is synced only when its root directory (`~/.claude`, `~/.codex`, `~/.gemini`,
`~/.cursor`, `<oc>`) exists. `<oc>` is `${XDG_CONFIG_HOME:-~/.config}/opencode`, where OpenCode itself reads its global config. Antigravity's `~/.gemini/config/AGENTS.md` link and
its MCP config additionally need `~/.gemini/config`. Cursor reads global rules from its settings, so the
effect of `~/.cursor/AGENTS.md` is unverified. Gemini CLI's `~/.gemini/settings.json` is not a
target.

Rules and skills are symlinks into the hub. MCP servers are compiled per target; see
[MCP servers](../mcp/README.md).

Syncing proves that links, serialized configs and the ledger are in the intended state. It does
not prove that an agent application loaded and honored that configuration.

## Choosing targets

Each target has two sync domains: **`links`** (its rules and skill symlinks) and **`mcp`** (its
MCP config file). A **selector** is a target name, meaning both domains, or a target name with a
domain suffix: `opencode:mcp`, `cursor:links`.

- **`disabledTargets`** in `${XDG_CONFIG_HOME:-$HOME/.config}/agent-hub/config.json` lists
  selectors to leave out by default:

  ```json
  { "agentsDir": "~/.agents", "disabledTargets": ["cursor", "opencode:mcp"] }
  ```

  This leaves Cursor out entirely and syncs OpenCode's rules and skills but not
  `opencode.json`. An unknown selector, a non-string entry or a non-array value makes every run
  exit `1`, as does a `config.json` that is not a JSON object.
- **`--targets <csv>`** (or `--targets=<csv>`) picks the selectors for one run of sync,
  `--check`, `--dry-run` or `--explain`, for example `--targets claude,opencode:links`. An
  unknown selector exits `2`. An explicit `--targets` list **replaces** `disabledTargets` for
  that run: `--targets cursor` acts on Cursor even when `"cursor"` is disabled. Give `--targets`
  once; repeating it exits `2`.

A run never plans changes for an excluded target or domain:

- Links and MCP entries placed there earlier stay as they are. Hub changes, including removed
  skills and servers, stop reaching them.
- `--check` reports drift for active targets only, plus any pending recovery journal.
- When the target is active again, the next run catches it up, including any prunes it missed.
- The one exception is Phase 0 recovery, which acts on `sync-agents`' own interrupted write
  whatever its target (see [Write-ahead recovery](../ownership/README.md#write-ahead-recovery)).
- `--disown-legacy <target>:<name>` needs that target's MCP domain in scope; otherwise the run
  exits `2` and names the selector to add.

A link is attributed to a target only when its path is exactly that target's rules file or a
direct child of its skills directory under the current `HOME` (for OpenCode, under the current
XDG config base). A scoped run keeps any record it cannot attribute, such as one written under a
different `HOME` or `XDG_CONFIG_HOME`.

`XDG_CONFIG_HOME` is used only when it is an absolute path, as the XDG spec requires. Ownership
is decided by physical location, not spelling: a link or MCP entry recorded under one spelling of
a directory (a symlinked `~/.config`, a `HOME` reached through a symlink) is recognized under any
other, so switching between such spellings causes no conflict, duplicate or prune. A sync
stores each record it plans under the spelling of that run (`rekey-link-record`,
`rekey-mcp-record`: ledger only, no file changes), so a record keeps a spelling that resolved
the last time you synced, and removing an old alias afterwards changes nothing. `--check` does
not count a re-key as drift. A record is re-keyed only to a spelling for the same target, and
only when no other desired spelling holds it: when `~/.codex/skills` is a symlink to
`~/.claude/skills`, the shared link is one object with one record, planned once. The record is
kept under the spelling whose path goes through the fewest symlinked directories
(`~/.claude/skills/<name>` in that example, even when `HOME` itself is reached through an
alias), so replacing the symlinked directory with a real one later leaves both links
agent-hub's: the next sync creates the link on the newly real side. When both agents' skills
directories are symlinks to a third directory, the record also stores the link's physical
destination, so replacing either symlink with a real directory leaves both links agent-hub's
(see [Ownership and recovery](../ownership/README.md#shared-skills-directories)). If
you remove an alias *before* syncing under the new spelling, the old records no longer match:
the run reports conflicts (and may describe MCP records as moved) and changes nothing;
`--adopt` then records the current spelling.

## Installing skills

`sync-agents --skill <source>` copies a skill into `<hub>/skills/<name>` (the name comes from
`SKILL.md` frontmatter) and then syncs. A source is a directory, a Git URL, a `.bundle`, a
`.zip` or `.skill` archive, or a tarball. Archives and repositories are unpacked into a temporary
directory first. Symlinks that escape the skill, absolute symlinks and cycles are refused.

- An installed skill that differs from the source is a conflict. `--force-skill` replaces only
  the differing canonical skill; it never authorizes replacing links or MCP entries.
- `--skill-only` installs into the hub without syncing targets.
- `--dry-run --skill <source>` inspects the source and changes nothing.

## Upgrading from a three-target version

Earlier versions compiled MCP servers only for Claude, Codex and Antigravity, though they already
linked rules and skills into `~/.cursor` and `~/.config/opencode`. After upgrading, the first
unscoped run also writes hub MCP servers into `~/.cursor/mcp.json` and `<oc>/opencode.json`, and
`--check` reports that as pending work until it happens.
The strict JSON refusals and `config.json` validation are also new, and apply to every target.

That run applies no Phase 2 change if either file has a personal server with the same name as a
hub server, or if either config is refused (see
[strict JSON refusals](../mcp/README.md#strict-json-refusals)). To leave Cursor's and OpenCode's
MCP configs untouched, as before, set `"disabledTargets": ["cursor:mcp", "opencode:mcp"]` before
the first run.

### If you set `XDG_CONFIG_HOME`

Earlier versions always used `~/.config/opencode`, even when `XDG_CONFIG_HOME` pointed elsewhere,
so OpenCode never read what they wrote. Now `<oc>` is `$XDG_CONFIG_HOME/opencode`. On the first
unscoped run after upgrading:

- **Links.** The old rules and skill links under `~/.config/opencode` are pruned (they are
  `sync-agents`' own symlinks) and created under `<oc>`. A scoped run keeps the old links until
  an unscoped run, because it cannot attribute them to OpenCode any more.
- **MCP entries.** Hub servers are written into `<oc>/opencode.json`. The ownership records for
  the servers written into `~/.config/opencode/opencode.json` are retired (`retire-moved-record`
  in `--dry-run`), and that old file is **left untouched**: remove its entries by hand if you no
  longer want them. A record never claims a same-named entry in the new file. If
  `<oc>/opencode.json` already has a server with a hub server's name, the run stops as a
  conflict; pass `--adopt` if it is identical, or rename one of them.

Run `sync-agents --dry-run` first to see each of these before anything is written.
