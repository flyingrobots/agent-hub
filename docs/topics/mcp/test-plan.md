# MCP servers: test plan

Contract ledger for [MCP servers](README.md). Tests are cited as `<file> › <exact test name>`
under `test/`; the documentation gate fails if a cited test does not exist.

## Canonical format and compilation

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| MCP-FMT-1 | Explicit transport, disabled-before-validation, family switching, the `gemini` to `antigravity` rename, and `--explain` output | Compiled entries per target; error text for a bare `url`; rename message | E2E | Implemented | `agent-hub.test.ts › Contract 8 (SHOULD #2 + Amendment 4): explicit transport, disabled-SSE precedence, family switching, antigravity rename, and --explain` |
| MCP-FMT-2 | An SSE server needs no override when the SSE-incapable targets are excluded; an active Codex still rejects it | Exit 0 with `--targets cursor` and with `disabledTargets: [codex, antigravity]`; exit 1 for `--targets codex` | E2E | Implemented | `adapters.test.ts › SSE server without per-agent overrides syncs when SSE-incapable adapters are excluded by --targets or disabledTargets` |
| MCP-CMP-1 | Claude, Codex and Antigravity receive compiled entries; a removed server is pruned from Claude | Parsed target configs | E2E | Implemented | `agent-hub.test.ts › installs skills, preserves tool-owned dirs, compiles MCP configs, passes --check, and prunes cleanly` |
| MCP-CMP-2 | Cursor and OpenCode receive stdio and sse entries in the documented shapes, keep unrelated keys and an existing `0600` mode, pass `--check`, and prune | Parsed configs, file mode | E2E | Implemented | `adapters.test.ts › Cursor and OpenCode compile stdio/http/sse, preserve unrelated keys & 0600 mode, pass --check, and prune cleanly` |
| MCP-CMP-3 | Cursor http is `{url, headers}`; OpenCode http is `{type: "remote", url, headers, enabled: true}` | Deep equality | E2E | Implemented | `adapters.test.ts › R-4b: Cursor and OpenCode compile http servers to the documented shapes` |
| MCP-CMP-5 | Prune from Codex and Antigravity; new-file modes (`0600`, Antigravity `0644`) | Parsed configs, mode | E2E | Implemented | `followups.test.ts › MCP-CMP-5: Codex and Antigravity prune removed servers; new configs get 0600 and Antigravity 0644` |
| MCP-CMP-4 | Emitted OpenCode entries use the current `mcp.servers` layout and only keys OpenCode's schema allows | Key-subset and required-key check against the schema's server definitions | E2E | Implemented | `opencode-v2.test.ts › fresh config: servers go under mcp.servers in OpenCode's current shape; --check is clean` |
| MCP-OC-1 | User content around OpenCode servers (other keys, `mcp.timeout`, the user's own current and legacy entries) is kept | Deep equality | E2E | Implemented | `opencode-v2.test.ts › user content is kept: other top-level keys, mcp.timeout, and the user's own mcp.servers and legacy entries` |
| MCP-OC-2 | A legacy `mcp.<name>` entry agent-hub wrote moves to `mcp.servers`; `--check` is then clean | Layout after sync; `--check` 0 | E2E | Implemented | `opencode-v2.test.ts › migration: a legacy mcp.<name> entry agent-hub wrote moves to mcp.servers; --check is then clean` |
| MCP-OC-3 | An unmanaged legacy entry with a hub server's name is a conflict | Exit 1; file unchanged | E2E | Implemented | `opencode-v2.test.ts › an unmanaged legacy entry with a hub server's name is a conflict; the file is unchanged` |
| MCP-OC-4 | Hub names `servers` and `timeout` are refused for OpenCode only | Exit 1 naming the reservation; Claude-only run succeeds | E2E | Implemented | `opencode-v2.test.ts › hub server names that collide with OpenCode's own mcp keys (servers, timeout) are refused for OpenCode only` |
| MCP-OC-5 | A non-object `mcp.servers` is refused | Exit 1; file unchanged | E2E | Implemented | `opencode-v2.test.ts › a non-object mcp.servers is refused without clobbering` |

## Codex TOML editing

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| MCP-TOML-1 | Multiline basic strings containing table-like text are preserved | Byte equality outside the edited span | Unit | Implemented | `toml-edit.test.ts › preserves multiline basic strings (""") containing [mcp_servers.demo] verbatim` |
| MCP-TOML-2 | Multiline literal strings are preserved | Byte equality | Unit | Implemented | `toml-edit.test.ts › preserves multiline literal strings (''') containing [mcp_servers.demo] verbatim` |
| MCP-TOML-3 | Bare, double-quoted and single-quoted keys and subtables are handled | Parsed result | Unit | Implemented | `toml-edit.test.ts › handles bare, double-quoted, and single-quoted keys and arbitrary subtables` |
| MCP-TOML-4 | Inline-table, dotted-key, bare `[mcp_servers]` and `[[mcp_servers]]` forms are refused | Throws | Unit | Implemented | `toml-edit.test.ts › refuses unsupported inline table, dotted root key, bare [mcp_servers], and [[mcp_servers]]` |
| MCP-TOML-5 | A change to any unrelated parsed value is refused | Throws | Unit | Implemented | `toml-edit.test.ts › semantic preservation guard rejects deliberate mutation of unrelated parsed values` |
| MCP-TOML-6 | CRLF line endings and basic-string escapes survive | CRLF present, no bare LF; escaped keys round-trip | Unit | Implemented | `hardening.test.ts › F17 & F18c: CRLF preservation and TOML 1.0/1.1 \e, \xHH, \uXXXX, \UXXXXXXXX basic-string key escapes` |
| MCP-TOML-7 | Updating a managed table keeps the comment after it and keeps the table's position | Comment text present before the next table; table order | Unit | Implemented | `toml-edit.test.ts › updating a managed section keeps the comment after it and keeps its position` |
| MCP-TOML-8 | Pruning a managed table keeps the comment after it | Comment text present | Unit | Implemented | `toml-edit.test.ts › pruning a managed section keeps the comment after it` |
| MCP-TOML-9 | A trailing comment at end of file after a managed table survives | Comment text present | Unit | Implemented | `toml-edit.test.ts › a trailing comment at end of file after a managed section survives` |
| MCP-TOML-10 | CRLF files keep CRLF and the following comment | CRLF only; comment present | Unit | Implemented | `toml-edit.test.ts › CRLF documents keep CRLF and the following comment` |
| MCP-TOML-11 | New servers are appended after existing content | Position | Unit | Implemented | `toml-edit.test.ts › a new server is appended after existing content` |
| MCP-TOML-12 | A multiline string whose last line starts with `#` is cut with its table; no stale fragment remains | Fragment absent; following comment present | Unit | Implemented | `toml-edit.test.ts › a multiline string whose last line starts with # is cut with its section, leaking no stale value` |
| MCP-TOML-13 | A trailing comment that mentions `"""` or `'''` survives update and prune | Comment text present | Unit | Implemented | `toml-edit.test.ts › a trailing comment that mentions triple quotes survives update and prune` |
| MCP-TOML-14 | Repeated rewrites of a mid-file server with `env` or `http_headers` subtables are byte-stable | Second rewrite byte-equal to first; no blank-line growth | Unit | Implemented | `toml-edit.test.ts › repeated rewrites of a mid-file server with env and http_headers subtables are byte-stable` |

## Strict JSON refusals

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| MCP-JSON-1 | A `.jsonc` sibling, comments or a trailing comma refuse the target; JSON containing `https://` passes | Exit codes; no `.json` created | E2E | Implemented | `adapters.test.ts › universal JSONC guard rejects .jsonc siblings and commented JSON across all JSON adapters without breaking https:// URLs` |
| MCP-JSON-2 | With both `<name>.json` and `<name>.jsonc` present, all four JSON targets refuse and leave the `.json` untouched | Byte equality | E2E | Implemented | `adapters.test.ts › JSONC guard fails closed when both <name>.json and <name>.jsonc exist, leaving the .json untouched` |
| MCP-JSON-3 | A repeated key at any depth, including escape-equivalent spellings, refuses the target and names the key | Exit 1, message, byte equality | E2E | Implemented | `adapters.test.ts › R-5: duplicate object keys in any JSON target fail closed and leave the file untouched` |
| MCP-JSON-4 | A non-object `mcpServers` refuses without clobbering | Byte equality | E2E | Implemented | `hardening.test.ts › F5: corrupt mcpServers (null / array) in JSON target fails closed without clobbering` |
| MCP-JSON-5 | A refusal names its scope, the `"<target>:mcp"` remedy and the resolved `config.json` path, and stops the whole run | Message text; Claude not updated | E2E | Implemented | `adapters.test.ts › R-2: a JSONC refusal names its scope and the --targets/disabledTargets opt-out` |
| MCP-JSON-6 | Non-object JSON roots, invalid TOML and a non-table `mcp_servers` carry the same remedy | Message text; file unchanged | E2E | Implemented | `adapters.test.ts › non-object JSON root, invalid TOML, and a non-table mcp_servers all carry the remedy` |
| MCP-JSON-8 | A Codex editor refusal (dotted `mcp_servers` key) names the `codex:mcp` remedy and the config path, and leaves the file untouched | Message text; byte equality | E2E | Implemented | `followups.test.ts › a Codex editor refusal (dotted mcp_servers key) names the codex:mcp remedy and the config path` |
| MCP-JSON-7 | Malformed JSON errors name the file | Message text | E2E | Implemented | `hardening.test.ts › F14: malformed JSON errors include the offending file path` |

## Conflicts

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| MCP-CONF-1 | A differing personal entry with a hub server's name is a conflict that names the `"<target>:mcp"` opt-out, and the file is untouched | Message text; byte equality | E2E | Implemented | `adapters.test.ts › R-2: a conflict with a personal entry in one target names the opt-out, not only --force` |
| MCP-CONF-2 | A disabled hub server never acquires ownership of a same-named personal entry, across `--check`, repeated syncs and re-enable | Ledger contents and target bytes | E2E | Implemented | `agent-hub.test.ts › Contract 1 (MUST #1): disabled MCP collision survives --check, 1st sync, 2nd sync, and re-enable without acquiring ownership` |
