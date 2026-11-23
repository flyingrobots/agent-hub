# Importing existing configuration

`sync-agents import` brings the MCP servers, rules file and skills you already have in your
agents into the hub, so you do not have to write the hub by hand. `sync-agents pull` copies one
server or skill from one agent. Both only plan until you pass `--apply`, and both refuse rather
than guess: if any item cannot be brought in exactly, nothing is written.

## Import everything

```bash
sync-agents import                    # plan: what would be imported, and what is refused
sync-agents import --apply --adopt    # write the hub, then sync with --adopt
sync-agents --check                   # exits 0: the agents already match the hub
```

What `import` reads, for each installed agent (its root directory exists):

- **MCP servers** from the agent's own config (`~/.claude.json`, `~/.cursor/mcp.json`,
  `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`, OpenCode's `mcp.servers`).
  Servers whose name is already in `<hub>/mcp/` are left to sync.
- **The rules file** (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`), when the hub has no `AGENTS.md`
  and every agent's own file (not a symlink) has the same text.
- **Skills**: an agent's own skill directories (with a `SKILL.md`, not symlinks) whose name the
  hub does not have; copies with the same name in several agents must be identical.

A server whose name is not a valid hub name (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `..`) is
refused and never used as a path. Skills are checked for unsafe content (such as symlinks out of
the skill) before anything is written.

Options: `--from <agent>` reads one agent only (others' configs are not read, so a broken one
elsewhere does not get in the way); `--only rules|skills|mcp` imports one kind;
`--rewrite-secrets` is described below.

## How servers are combined

Each agent's entry is read back into the canonical form. Identical specs across agents become
the base `mcp`; an agent whose spec differs gets the smallest `overrides.<agent>` that reproduces
it; native fields the canonical form does not model go to `overrides.<agent>.extra` (see
[MCP servers](../mcp/README.md)). An installed agent that lacks the server gets
`overrides.<agent>.disabled: true`, so the next sync adds it nowhere new. The same input always
gives the same files.

An entry is imported only if compiling the result gives back exactly the entry the agent has
(the round trip). Otherwise the server is refused, naming each field that would be added, lost
or changed (values are not printed). Agent-specific syntax the canonical form cannot carry is
refused too: Claude Code's `${VAR:-default}`, Cursor's `${userHome}` and similar, and literal
`{env:...}` text outside OpenCode. An agent's native references come back as `${env:NAME}`
(Claude `${NAME}`, OpenCode `{env:NAME}`, Codex `env_vars`, `bearer_token_env_var` and
`env_http_headers`).

A server is also refused when one agent's spec cannot be written as an override of the base,
because an override can add or change an `env` key or header but not remove one. Import it from
one agent with `--from`.

## Secrets

A literal that looks like a credential (see
[Plaintext secrets](../mcp/README.md#plaintext-secrets)) stops `import --apply`: copying it into
the hub would spread it further. Pass `--rewrite-secrets` to write each such value as
`${env:NAME}` instead. Only the variable names are printed, never the values. Then set those
variables where your agents run, and run `sync-agents --force` to replace the literal values in
the agents' own configs with the references (the entries differ from the hub now, so a plain
sync stops on them). A credential in an agent's native fields that sync-agents passes through as
written (`overrides.<agent>.extra`, such as OpenCode's `oauth.clientSecret`) cannot become a
reference, so it is refused even with `--rewrite-secrets`: remove it from the agent's entry
first. A Codex entry `config.toml` could not hold again (nested tables in its native fields) is
refused as not lossless.

## Pull one item

```bash
sync-agents pull --from claude mcp/my-server            # plan
sync-agents pull --from claude mcp/my-server --apply    # write and sync with --adopt
sync-agents pull --from cursor skill/my-skill --apply
```

Use `pull` after adding a server with an agent's own tool (`claude mcp add`). With `--apply` it
writes the hub entry and syncs with `--adopt`, so the other agents get the server and
`sync-agents --check` exits 0. When the hub already has the server and the agent's entry
differs, `pull` refuses unless you pass `--as-override`, which records the difference as
`overrides.<agent>`.

## Output

Both commands print JSON Lines like a sync (see [Output](../output/README.md)): an `op` line per
item (`import-server`, `import-rules`, `import-skill`, `import-rewrite-secret`, `pull-server`,
`pull-skill`), a `conflict` line per refusal, the lines of the sync `--adopt` runs, and one
final `summary` (`planned`, `applied`, `in_sync` or `conflicts`).
