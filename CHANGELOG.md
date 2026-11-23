# Changelog

All notable changes to agent-hub are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor
version may change behavior in ways that need an operator's attention; such
changes are called out under **Changed** with what to do.

## [Unreleased]

### Added

- Cursor (`~/.cursor/mcp.json`, `~/.cursor/skills/`) and OpenCode
  (`~/.config/opencode/opencode.json`, `~/.config/opencode/skills/`,
  `~/.config/opencode/AGENTS.md`) MCP adapters, compiling `stdio`, `http` and
  `sse` servers.
- Target scoping: `--targets <csv>` for one run and `"disabledTargets"` in
  `agent-hub/config.json` by default. A selector is a target name or one of its
  domains (`<target>:mcp`, `<target>:links`). Excluded targets are never planned
  or pruned.
- Strict JSON refusals for every JSON MCP target: a `.jsonc` sibling, comments,
  trailing commas, or a key repeated within one object stop the run with a remedy
  naming the `"<target>:mcp"` opt-out and the resolved config path.
- Write-ahead recovery journal (Phase 0), OS-held `flock(2)` apply lock, and the
  XDG v2 ownership ledger under `${XDG_STATE_HOME:-~/.local/state}/agent-hub/`.
- `--explain`, `--adopt` with strict adoption equivalence, `--force-skill`,
  `--disown-legacy`, and the TOML-preserving Codex editor.

### Changed

- Upgrading from a three-target build: the first unscoped run also writes hub MCP
  servers into Cursor and OpenCode configs where those directories exist. Set
  `"disabledTargets": ["cursor:mcp", "opencode:mcp"]` first to keep the previous
  behavior.
- A `config.json` that is not an object, or whose `disabledTargets` is invalid,
  now fails every sync run with exit 1.
- Scoped runs recognize link ownership only for exact layout paths, so a record
  left by an earlier, overlapping HOME is never attributed to the wrong target.

### Fixed

- A duplicate key in a JSON target config no longer lets a rewrite silently drop
  the user's earlier block of MCP servers.
- Two prune assertions in the test suite that could never fail (they used
  `existsSync` on a dangling link) now use `lstat`.
