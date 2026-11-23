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

Values are copied verbatim. agent-hub does not interpret `${...}` placeholders; whether a target
application expands them is up to that application.

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
