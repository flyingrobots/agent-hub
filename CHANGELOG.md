# Changelog

All notable changes to agent-hub are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor
version may change behavior in ways that need an operator's attention; such
changes are called out under **Changed** with what to do.

## [Unreleased]

### Added

- Weekly Dependabot updates for Bun devDependencies (`bun.lock`) and SHA-pinned GitHub Actions
  (flyingrobots/agent-hub#65).

### Changed

- `@types/bun` and `typescript` are pinned to the exact versions `bun.lock` resolves (1.4.5 and
  5.9.3) instead of caret ranges (flyingrobots/agent-hub#65).

### Fixed

- A target JSON config that is empty or holds only whitespace (as Antigravity creates
  `mcp_config.json`) no longer stops the whole run as invalid JSON; it is treated like an absent
  file ([#54](https://github.com/flyingrobots/agent-hub/issues/54)).
- On macOS, `--adopt` no longer refuses an identical copy because one side carries
  `com.apple.provenance`, the attribute macOS adds to files written by some applications. Any
  other differing extended attribute still blocks adoption.

## [0.2.0] - 2026-11-23

Vault secrets with grant-bound `sync-agents exec`, project mode with an attacker-safe lockfile,
and a plaintext credential in a hub spec now stops the sync (see **Changed** for what to do).

### Changed

- Codex `config.toml` tables, keys and new sections are rendered in plain code-unit order instead of
  `localeCompare`, so the bytes never depend on the locale (flyingrobots/agent-hub#11). Ordering
  changes only for keys whose locale order differs from code-unit order.
- **A literal credential in a hub MCP spec now stops the sync** (flyingrobots/agent-hub#50). A
  field the plaintext detector flags still prints its `agent_hub.warning` (schema 1.1.0, same
  fields, clarified description), and now also an `agent_hub.conflict`, so the run writes nothing
  and exits 1; `--force` does not override it. **What to do:** run `sync-agents --check`; for each
  flagged field, write it as `${env:NAME}` or `${vault:KEY}`, or list it in
  `allowPlaintextFields` if it is not a secret, and rotate any credential that was synced before.

### Added

- Project mode (flyingrobots/agent-hub#11). `sync-agents --project [--dir <repo>]` syncs
  `<repo>/.agents/` into `.mcp.json`, `.cursor/mcp.json`, `opencode.json`, `.codex/config.toml`
  and `CLAUDE.md`, `AGENTS.md` and `.claude/skills/<name>` symlinks, owned through a committed,
  sorted, machine-independent `.agents/sync.lock.json`. Every lockfile entry is validated as
  hostile input (repo-relative, symlink-free containment, known output set, exact-match pruning)
  and any invalid entry fails the run closed. Plaintext secrets block; vault servers use the bare
  `sync-agents` launcher and grants are never created. `--relock` rebuilds the lockfile.
  Antigravity is not supported in project mode.
  Project mode refuses symlinks and non-regular files under `.agents/mcp`, a non-regular lockfile
  (which `--relock` replaces), a git toplevel that does not contain the working directory, and
  case-only path collisions on case-folding volumes; apply runs on one repository are serialized by
  a writer lock in the user's state directory.
- Vault secrets for stdio MCP servers (flyingrobots/agent-hub#10). `${vault:KEY}` as a whole `env`
  value makes every agent run the server through `sync-agents exec`, which checks an exact
  (key, variable, command line, real program, pass-through variables) grant, reads the value from the macOS keychain, scrubs the
  environment and replaces itself with the server via `execve(2)` (same PID), appending a
  value-free line to `exec-audit.jsonl`. `sync-agents secret set|grant|revoke|list` manage values
  and grants; `secret set` never puts the value in an argv. New output message
  `agent_hub.grant` 1.0.0. Same-user threat model, documented in `docs/topics/vault/`.

### Fixed

- Shared skills directories: when `~/.claude/skills` and `~/.codex/skills` are both symlinks to
  a third directory, replacing either one with a real directory no longer reports the other
  agent's link as unmanaged. The link's record now stores its physical destination (`physical`,
  an optional field; the ledger stays version 2 and older ledgers load unchanged, gaining the
  field on the next sync of a shared layout). A scoped run such as `--targets codex:links` no
  longer retires an excluded target's duplicate record for a shared link.
  (flyingrobots/agent-hub#37)

## [0.1.0] - 2026-11-22

The first release: five agent targets, MCP compilation with environment references, import and
pull, commands and agents, JSON Lines output, and standalone binaries.

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

- A Codex MCP value containing DEL (U+007F) no longer makes the `config.toml` rewrite fail.
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

[Unreleased]: https://github.com/flyingrobots/agent-hub/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/flyingrobots/agent-hub/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/flyingrobots/agent-hub/releases/tag/v0.1.0
