# Changelog

All notable changes to agent-hub are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor
version may change behavior in ways that need an operator's attention; such
changes are called out under **Changed** with what to do.

## [Unreleased]

### Added

- Standalone binaries: `bun run build:bin` compiles `dist/sync-agents`, and
  `./install.sh --binary <file>` installs one as the runtime (no Bun needed to run it).
  Tagged releases publish unsigned binaries for macOS and Linux with `SHA256SUMS` and
  GitHub build-provenance attestations; see docs/topics/install.
- Cursor (`~/.cursor/mcp.json`, `~/.cursor/skills/`) and OpenCode
  (`${XDG_CONFIG_HOME:-~/.config}/opencode/` `opencode.json`, `skills/`, `AGENTS.md`)
  MCP adapters, compiling `stdio`, `http` and
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

- OpenCode servers are written in its current `mcp.servers` layout instead of the deprecated
  direct `mcp.<name>` form. Run `sync-agents --dry-run` first: entries `sync-agents` wrote in the
  old layout, unchanged since, move on the next sync (`mcp-migrate-layout`), without the old
  `enabled: true`. An old-layout entry named like a hub server that `sync-agents` did not write,
  or that was edited, stops the run as a conflict that `--force` and `--adopt` do not override:
  move it to `mcp.servers.<name>` yourself, rename or remove it, or exclude `"opencode:mcp"`. Your
  own old-layout entries with other names stay put and are listed by `--explain`. The hub server
  names `servers` and `timeout` are refused for OpenCode and stop every run that includes it
  until you rename the server or set `overrides.opencode.disabled: true`.
- OpenCode's rules, skills and `opencode.json` live under
  `${XDG_CONFIG_HOME:-~/.config}/opencode`, matching OpenCode itself. If you set an absolute
  `XDG_CONFIG_HOME`, the first unscoped sync after upgrading moves the links there, writes hub
  servers into the new `opencode.json` (a same-named entry already there stops the run as a
  conflict; use `--adopt` if identical), and retires the records for the old
  `~/.config/opencode/opencode.json` without editing it: remove its entries by hand if unwanted.
  Run `sync-agents --dry-run` first. A relative `XDG_CONFIG_HOME` or `XDG_STATE_HOME` is now ignored, per the XDG spec.
- Link and MCP ownership is compared by physical location, so a symlinked `~/.config` or an
  aliased `HOME` no longer turns into conflicts, duplicates or prunes while the recorded spelling
  still resolves; duplicate records for one link are retired (`drop-duplicate-record`).
- MCP ownership records apply only to the config file they were written for; a record for a
  moved file can no longer claim, overwrite or prune a same-named entry in the new file.
- `--disown-legacy` for a target whose MCP domain is out of scope, and a repeated
  `--targets`, now exit 2 instead of being silently ignored.
- Upgrading from a three-target build: the first unscoped run also writes hub MCP
  servers into Cursor and OpenCode configs where those directories exist. Set
  `"disabledTargets": ["cursor:mcp", "opencode:mcp"]` first to leave those two MCP
  configs untouched.
- A `config.json` that is not an object, or whose `disabledTargets` is invalid,
  now fails every sync run with exit 1.
- Scoped runs recognize link ownership only for exact layout paths, so a record
  left by an earlier, overlapping HOME is never attributed to the wrong target.

### Fixed

- Security: a `.env` or `bunfig.toml` in the directory `sync-agents` or `install.sh` was run
  from could redirect the hub, config and state paths, or run its own code, because Bun loads
  both by default. Every `bun` call now ignores them, and binaries are compiled not to load them.
- Rewriting a Codex table that holds a long hand-written multiline string whose lines start
  with `#` no longer takes time quadratic in its length; the cut comes from the TOML scanner.
- `src/cli.ts --print-dir` ignored a valid `agentsDir` when `disabledTargets` was
  invalid. Codex editor refusals now carry the `codex:mcp` remedy.
- `install.sh`'s hub-overlap guard missed a hub path written with `..` under a
  nonexistent directory, so a later install could delete skills in a hub that was
  also the runtime prefix. Both Bash path canonicalizers now normalize `..` the way
  the engine does, and the guard now checks every hub the runtime could resolve, including an
  exported `AGENTS_DIR` alongside `--agents-dir`.
- The Codex TOML editor no longer deletes a comment that sits between a managed
  `[mcp_servers.<name>]` table and the next table, and an updated table stays where
  it was instead of moving to the end of the file (flyingrobots/agent-hub#15).
- A duplicate key in a JSON target config no longer lets a rewrite silently drop
  the user's earlier block of MCP servers.
- Two prune assertions in the test suite that could never fail (they used
  `existsSync` on a dangling link) now use `lstat`.
