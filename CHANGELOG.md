# Changelog

All notable changes to agent-hub are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor
version may change behavior in ways that need an operator's attention; such
changes are called out under **Changed** with what to do.

## [Unreleased]

### Added

- `sync-agents import` and `sync-agents pull`: bring agents' existing MCP servers, rules and
  skills into the hub. Each entry is imported only if compiling it back reproduces it exactly;
  identical specs across agents become the base and differences become overrides; plaintext
  secrets stop an import unless `--rewrite-secrets`. Planning is the default; `--apply` writes.
  See docs/topics/import.
- `overrides.<agent>.extra`: native fields for one agent that the canonical spec does not model.
- Commands and agents: `<hub>/commands/<name>.md` and `<hub>/agents/<name>.md` are generated
  into Claude Code, OpenCode, Cursor and (agents only) Codex, each in its own format, from a
  portable frontmatter subset; anything else goes under `targets.<agent>`. See
  docs/topics/primitives.
- Environment references: write `${env:NAME}` in a hub server spec instead of a secret. Claude
  Code, Cursor and OpenCode get their native syntax in every field; Codex gets `env_vars`,
  `bearer_token_env_var` and `env_http_headers` for the forms it can express; anything a target
  cannot express is refused for that target. `sync-agents` never reads the variable.
- Plaintext-secret warnings: a literal that looks like a credential (known token patterns,
  secret-bearing field names, URL credentials) prints an `agent_hub.warning` line on every run;
  `allowPlaintextFields` in `mcp.json` silences a field. See docs/topics/mcp.

- Machine-readable output: every line `sync-agents` prints, on stdout and stderr, is a JSON
  object naming its schema (`_schema`), with `kind`, `run_id` and `message`. The schemas, one
  per message type and each versioned on its own, are in `schemas/`; `sync-agents --schema`
  prints them. See docs/topics/output.

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

- **`${env:NAME}` in a hub server spec is now a reference, no longer literal text.** It is
  compiled for each target, refused for Antigravity and for Codex outside the forms it can
  express, and a malformed one (`${env:lower}`, unterminated) stops the run. Run
  `sync-agents --dry-run` first; disable a refused server for that target, or move the literal
  into that target's override.

- **Breaking: output is JSON Lines by default.** Scripts that read `sync-agents` output as text
  must add `--human` (alias `--humanize`) to get prose, for example
  `"$(sync-agents --print-dir --human)"`; `--help` prints JSON lines too. Earlier versions reject
  `--human` (exit 2), so change such scripts when you upgrade, not before; `sync-agents --schema`
  exits 0 only on a version with JSON Lines. Exit codes are unchanged, except that
  `bin/sync-agents` no longer reads another option's value as `--help` or `--print-dir`
  (`--skill --print-dir` now fails as the engine does). The prose is the same
  except that every run now ends with one summary or error line: a sync that changed something
  ends with `applied N change(s).`, `--dry-run` and `--explain` with `N change(s) planned`, and
  an ambiguous recovery with an error line after the recovery line, and a doubled
  `sync-agents: mcp-sync:` prefix on refusals is now one prefix. Lines are printed as they
  happen rather than at the end of the run. `src/mcp-sync.ts --print-dir` now prints the hub
  instead of running an MCP sync.
- OpenCode servers are written in its current `mcp.servers` layout instead of the deprecated
  direct `mcp.<name>` form. Run `sync-agents --dry-run` first: entries `sync-agents` wrote in the
  old layout, unchanged since, move on the next sync (`mcp-migrate-layout`), without the old
  `enabled: true`. An old-layout entry named like a hub server that `sync-agents` did not write,
  or that was edited, stops the run as a conflict that `--force` and `--adopt` do not override:
  move it to `mcp.servers.<name>` yourself, rename or remove it, or exclude `"opencode:mcp"`. Your
  own old-layout entries with other names stay put and are listed by `--explain`. Hub servers
  may be named `servers` or `timeout`; they are written to `mcp.servers.<name>`, and
  agent-hub's own old-layout entries under those names move there too.
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

- A Codex `config.toml` that starts with a UTF-8 BOM directly before a managed
  `[mcp_servers.<name>]` table is edited instead of refused; the BOM is kept.
- Security: a `.env`, `bunfig.toml`, `tsconfig.json` or `jsconfig.json` in (or, for the last
  two, above) the directory `sync-agents` or `install.sh` was run from could redirect the hub,
  config and state paths, or run its own code, because Bun loads them by default. Every `bun`
  call now ignores them, and binaries are compiled not to load them.
- Ownership records now move to the spelling of the run that plans them (ledger only), so a
  `HOME` or `~/.config` alias removed after syncing under the real path no longer turns into
  conflicts or "moved" MCP records.
- Two agents' skill directories that are one physical directory (`~/.codex/skills` a symlink
  to `~/.claude/skills`) no longer fail the first sync with a stale-snapshot error: the shared
  link is planned once, and its record lives under the spelling with no symlink in its path,
  so replacing the symlinked directory later leaves both links owned.
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
