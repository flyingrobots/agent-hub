# MCP servers

Each MCP server is declared once in the hub and compiled into every active target's native
config. This page is the reference for the canonical format, what each target receives, and when
a target config is refused. Contracts are tracked in [test-plan.md](test-plan.md).

## Canonical format

A server lives at `<hub>/mcp/<server>/mcp.json`. The directory name is the server name.

```json
{
  "mcp": {
    "transport": "stdio",
    "command": "/opt/homebrew/bin/shadcn",
    "args": ["mcp"],
    "env": { "MODE": "default" }
  },
  "overrides": {
    "codex": { "env": { "MODE": "codex" } }
  }
}
```

A remote server sets `url`, `transport` and optional `headers`:

```json
{
  "mcp": {
    "transport": "sse",
    "url": "https://example.com/mcp/sse",
    "headers": { "X-Client": "agent-hub" }
  },
  "overrides": {
    "antigravity": { "disabled": true },
    "codex": { "disabled": true }
  }
}
```

Rules:

- **Transport.** `command` implies `"transport": "stdio"`. A `url` must set `"transport"` to
  `"http"` (streamable HTTP) or `"sse"`. `args` and `env` are invalid on a remote server;
  `headers` is invalid on stdio.
- **Overrides.** The spec for a target is the base `mcp`, then inline `overrides.<target>`, then
  `<hub>/mcp/<server>/<target>/mcp.json`, each layered on the last. Override keys are the five
  target names. A `gemini` key or directory fails with a message to rename it `antigravity`.
- **Family switching.** An override that switches between stdio and remote drops the inherited
  fields of the other family (`command`/`args`/`env` versus `url`/`headers`).
- **Disabled.** `"disabled": true` omits the server from that target. It is applied before
  transport validation, so a disabled SSE server is never rejected by a target that lacks SSE.
- **Scope.** A target excluded from the run (see
  [Choosing targets](../sync/README.md#choosing-targets)) is not compiled at all, so it cannot
  reject a transport it does not support.

Values are copied as written, except `${env:NAME}` references, which are compiled per target
(next section). Any other `${...}` or `{...}` text is copied as is, and the target application
decides what it means: Claude Code would expand a literal `${HOME}`, and OpenCode a literal
`{env:HOME}`, so keep target-specific syntax in that target's override.

## Environment references

Write a secret, or anything else that varies, as `${env:NAME}` instead of a literal. `NAME` must
match `^[A-Z_][A-Z0-9_]*$`; an unterminated or invalid reference stops the run. `sync-agents`
never reads the variable: each agent reads it from its own environment when it starts the
server, so the value never lands in a config file.

```json
{
  "mcp": {
    "transport": "http",
    "url": "https://api.example.com/mcp",
    "headers": { "Authorization": "Bearer ${env:EXAMPLE_TOKEN}" }
  }
}
```

Each target either compiles a reference into its own syntax or refuses it. A refusal stops the
whole run, like any other planning error (an `error` line with code `plan`, naming the server,
the target and the field), so nothing is written to any target; set
`overrides.<target>.disabled: true` for that server, or give that target a literal in its
override, to sync the rest:

| Target | `command` | `args` | `env` | `url` | `headers` |
| --- | --- | --- | --- | --- | --- |
| `claude` | `${NAME}` | `${NAME}` | `${NAME}` | `${NAME}` | `${NAME}` |
| `cursor` | `${env:NAME}` | `${env:NAME}` | `${env:NAME}` | `${env:NAME}` | `${env:NAME}` |
| `opencode` | `{env:NAME}` | `{env:NAME}` | `{env:NAME}` | `{env:NAME}` | `{env:NAME}` |
| `codex` | refused | refused | only `K = "${env:K}"`, compiled to `env_vars = ["K"]` | refused | only `Authorization: "Bearer ${env:X}"` (`bearer_token_env_var = "X"`) or a whole value `"${env:X}"` (`env_http_headers`) |
| `antigravity` | refused | refused | refused | refused | refused |

Limits worth knowing:

- Claude Code documents `${VAR}` expansion for these five fields; in a remote server's `url` and
  `headers` it reads some credential variables (its own `ANTHROPIC_*` keys, cloud and proxy
  tokens) as empty instead of expanding them. Use a name of your own, such as
  `EXAMPLE_TOKEN`.
- An unset variable expands to empty in OpenCode, and is left as written in Claude Code (which
  warns in `claude mcp list`). In Codex, an unset `env_vars` name is simply not passed to the
  server, an unset `env_http_headers` variable drops that header, and an unset
  `bearer_token_env_var` stops the server from starting. Cursor does not document it.
- Verified: Claude Code 2.1.323 expands `${VAR}` in a user-scope `~/.claude.json` entry's
  `command`, `args` and `env` (`claude mcp list` started the server with the expanded values);
  its documentation covers `url` and `headers` too. Cursor documents `${env:VAR}` in all five
  fields for its MCP config, without saying whether that includes the global
  `~/.cursor/mcp.json`.
- Codex has no interpolation, so a reference anywhere else, or with text around it
  (`"Bearer ${env:X}-suffix"`), is refused for Codex. In `env` the key must be the variable's own
  name (`GITHUB_TOKEN = "${env:GITHUB_TOKEN}"`; `TOKEN = "${env:GH_TOKEN}"` is refused). The
  `Authorization` header name is matched in any case; the value must be exactly
  `Bearer ${env:X}` with one space, and a header set twice in different capitalizations is
  refused. Only fields the transport writes are checked (a stdio server's leftover `headers`
  are ignored).
- Antigravity expands nothing, so a server that needs a reference is refused there; disable it
  for Antigravity, or give Antigravity a literal in `overrides.antigravity` (which keeps one
  plaintext copy, and is reported as below).
- **Where to set the variable.** Each agent reads it from its own process environment when it
  starts the server. A variable exported in `~/.zshrc` reaches agents started from that shell
  (Claude Code, Codex, OpenCode in a terminal). An app started from the Dock, Finder or
  Spotlight on macOS (Cursor, Antigravity, desktop apps) does not read shell profiles: set the
  variable for GUI apps (`launchctl setenv NAME value`, which lasts until logout) or start the
  app from a shell, then restart it. A reference to a variable the agent cannot see gives the
  server an empty or literal value, typically a 401 from the server.
- **Existing configs.** Before this release a `${env:...}` string was copied verbatim. It is
  now compiled, or refused for Codex and Antigravity, and a malformed one
  (`${env:lowercase}`, an unterminated `${env:`) stops the run. There is no escape for a literal
  `${env:` in a value.

### Plaintext secrets

On every run that plans MCP servers (sync, `--dry-run`, `--check`, `--explain`; not `--skill-only`,
and not a read-only run that stops on a pending recovery), `sync-agents` prints one
`agent_hub.warning` line per field, before the run's operations, for each literal value in a
server spec that looks like a credential. Every layer is checked (the base `mcp`, inline
overrides and `<target>/mcp.json` files, as each target resolves them); a field flagged for
several targets is reported once. It does not refuse, and the exit code is
unchanged; the value is never printed. It checks for known token patterns (`sk-…`, `ghp_…`, `github_pat_…`,
Slack `xox?-…`, Google `AIza…`, AWS `AKIA…`, PEM private keys), any literal under an `env` key or
header name with a credential word as one of its parts (split on `_`, `-`, `.` and camelCase:
`token`, `secret`, `password`, `passwd`, `pwd`, `pass`, `passphrase`, `pat`, `apikey`,
`credential(s)`, `authorization`, `bearer`; the pairs `api key`, `access key`, `private key`,
`secret key`, `auth key`, `session key`, `auth token`; `password`, `secret`, `apikey` or
`credential` inside a longer part, as in `PGPASSWORD`; or the `Cookie` header), and a URL with
an embedded user and password. A second literal for the same field in another layer (a
per-target `mcp.json`) is reported on its own.
These are known token patterns and secret-bearing field names, not a scanner: a secret in any
other shape is not noticed. To keep a literal you intend, name its field:

```json
{ "mcp": { "command": "/bin/x", "env": { "API_KEY": "public-demo-key" } }, "allowPlaintextFields": ["env.API_KEY"] }
```

`allowPlaintextFields` sits at the top level of `<hub>/mcp/<server>/mcp.json`, next to `mcp` and
`overrides`, and applies to every target's resolved spec. Field paths are `command`, `args[i]`,
`env.<KEY>`, `url` and `headers.<Name>`. Name matching is case-insensitive and by whole parts, so
`GIT_AUTHOR_NAME`, `MAX_TOKENS` or `X-Session-Id` are not reported; a non-secret
`SECRET_FILE` is, and can be listed. Paths match exactly (case-sensitive), and an entry naming
a field that does not exist is accepted silently.

## What each target receives

| Target | File and key | stdio | http | sse | New file mode |
| --- | --- | --- | --- | --- | --- |
| `claude` | `~/.claude.json` `mcpServers` | `{type: "stdio", command, args, env?}` | `{type: "http", url, headers?}` | `{type: "sse", url, headers?}` | `0600` |
| `codex` | `~/.codex/config.toml` `[mcp_servers.<name>]` | `command`, `args?`, `env?` | `url`, `http_headers?` | refused | `0600` |
| `antigravity` | `~/.gemini/config/mcp_config.json` `mcpServers` | `{command, args?, env?, disabled: false}` | `{serverUrl, headers?, disabled: false}` | refused | `0644` |
| `cursor` | `~/.cursor/mcp.json` `mcpServers` | `{type: "stdio", command, args?, env?}` | `{url, headers?}` | `{url, headers?}` | `0600` |
| `opencode` | `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json` `mcp.servers` | `{type: "local", command: [cmd, ...args], environment?}` | `{type: "remote", url, headers?}` | same as http | `0600` |

An existing file keeps its mode. Keys outside the MCP map, and servers agent-hub does not manage,
are preserved. A target's MCP config is planned only when its MCP root exists: `~/.claude`,
`~/.codex`, `~/.gemini/config`, `~/.cursor` or `${XDG_CONFIG_HOME:-~/.config}/opencode`.

OpenCode entries use its current layout, `mcp.servers.<name>` (see its schema at
`https://opencode.ai/config.json`). Everything else under `mcp`, such as `mcp.timeout`, is kept.
Entries in the previous layout, directly under `mcp.<name>`:

- one that `sync-agents` wrote, and that is unchanged since (its ledger digest matches), is
  moved to `mcp.servers.<name>` (`mcp-migrate-layout` in `--dry-run`). The move drops the old
  layout's `enabled: true`, which the current layout does not have. If that server has since
  been removed from the hub or disabled for OpenCode, it is moved and then removed in the same
  run, as any managed server would be;
- one that it did not write, or that was edited, and that has a hub server's name (or a
  sync-agents record), stops the run as a conflict. `--force` and `--adopt` do not resolve it,
  because `sync-agents` will not move or replace an entry it cannot prove it wrote. Move the
  entry to `mcp.servers.<name>` yourself, rename or remove it, rename the hub server, or leave
  OpenCode's MCP config out with `"opencode:mcp"`. If the edit was deliberate, such as turning
  the server off with `enabled: false`, say so in the hub (`overrides.opencode.disabled: true`)
  and then remove `mcp.<name>` by hand; removing it without the override brings the server back.
  An unmanaged entry that carries `enabled` cannot be adopted, because the current layout has no
  such key;
- any other is left where it is, and `--explain` lists it (`leave-legacy-unmanaged`).

A file holding both layouts keeps working: OpenCode reads the direct `mcp.<name>` entries and
the `mcp.servers` map and merges them, so your own old-layout servers still load next to the
ones agent-hub writes. If both layouts name the same server, the two OpenCode code lines differ:
release v1.19.6 keeps the direct entry (its `v2-compat/read/mcp-merge` test fixture), while the
`dev` branch keeps the `mcp.servers` one and reports a conflict (`mergeMaps` in
`packages/core/src/config/normalize.ts`). agent-hub never writes such a pair: a same-named
entry in the old layout stops the run, as above. On `dev`, a direct entry that has only an
`enabled` key is dropped with a diagnostic. These statements come from reading OpenCode's source
(anomalyco/opencode, tag `v1.19.6` and `dev` at `7b70422`), not from running OpenCode.

The hub server names `servers` and `timeout` are refused for OpenCode. They are legal names
inside `mcp.servers`, but in the previous layout they collide with OpenCode's own `mcp.servers`
and `mcp.timeout` keys, so refusing them keeps an upgrade unambiguous. Until you rename the
server or disable it for OpenCode (`overrides.opencode.disabled: true`), every run that includes
OpenCode's MCP config stops. A disabled server still names its entry: a server of your own at
`mcp.servers.timeout` is then a conflict, and `--force` would remove it, so rename the hub server
instead when you have one.

A server by one of those names that an earlier `sync-agents` wrote in the previous layout is
removed once it is disabled or renamed, provided it is unchanged (`mcp-remove-reserved-legacy`).
If a `timeout` entry was changed, its record is retired and `mcp.timeout` is left alone
(`retire-reserved-record`). A `mcp.servers` holding any value that is not a server object, which
is what the previous layout's server named `servers` looks like, is refused unless
`sync-agents` wrote it and it is unchanged, so nothing is ever written inside it.

### Codex TOML editing

Codex `config.toml` is edited in place by a TOML 1.0 lexical scanner. Only the
`[mcp_servers.<name>]` sections agent-hub manages are rewritten; everything outside them,
including comments, multiline strings, CRLF line endings and unrelated tables, is kept as it was.
An updated section stays where it was, a new one is appended at the end, and a comment or blank
lines between a managed section and the next table stay with that next table. Comments *inside*
a managed section are regenerated with it and not kept. Inline-table, dotted-key and
array-of-tables forms of `mcp_servers` are refused before any write. After rendering, every
unrelated parsed value is compared with the original, and the write is refused if any changed.

## Strict JSON refusals

The four JSON targets (`antigravity`, `claude`, `cursor`, `opencode`) refuse to modify a config
when:

- a `.jsonc` sibling exists (for example `opencode.jsonc` next to `opencode.json`), whether or
  not the `.json` exists;
- the `.json` has comments or trailing commas (it is parsed with `JSON.parse`, never by scanning
  text for `//`, so `https://` URLs are fine);
- an object repeats a key, which `JSON.parse` would silently resolve to the last value. The error
  names the decoded key and its location;
- the document root, or its `mcpServers`/`mcp` value, is not an object.

Codex is refused on invalid TOML, a non-table `mcp_servers`, or a form the editor cannot change
safely (above).

Any target config that is not a regular file is refused, including one that is a symlink (as
dotfile managers often create). JSON targets are rewritten with `JSON.stringify` and two-space
indentation: values and key order survive, other formatting does not.

**A refusal stops the whole run.** Every active target is planned before anything is written, so
no Phase 2 target or ledger change is applied, and `--check` fails too. Phase 0 recovery of an
earlier interrupted write may still complete. Every refusal listed here, including the Codex
editor's own, names the target, the resolved `config.json` path and the remedy: add `"<target>:mcp"` to `disabledTargets`, which leaves only
that tool's MCP config alone while its rules and skill links keep syncing. Do not strip comments
from a tool's own config just to make `sync-agents` run.

## Entries agent-hub does not own

A server already present in a target config, with the same name as a hub server but different
content, is a conflict: the run stops, and the message offers `--force` (replace it), renaming or
withdrawing the hub server, or excluding that target with `"<target>:mcp"`. An identical
unmanaged entry can be recorded as owned with `--adopt`. Ownership is covered in
[Ownership and recovery](../ownership/README.md).
