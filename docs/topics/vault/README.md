# Vault secrets and `sync-agents exec`

A stdio MCP server can get a secret in its environment without the value appearing in any agent's
config file. The value lives in the macOS keychain; the hub spec names it; each agent's config
runs the server through `sync-agents exec`, which checks a grant, reads the value, and replaces
itself with the server.

This page is the reference. The threat model is at the end, and the contract ledger is
[test-plan.md](test-plan.md).

## Writing a vault reference

In a server's `mcp.json`, write `${vault:KEY}` as the whole value of an `env` entry:

```json
{
  "mcp": {
    "command": "/opt/tools/github-mcp",
    "args": ["--stdio"],
    "env": { "GITHUB_TOKEN": "${vault:github}", "LOG_LEVEL": "info" }
  }
}
```

`KEY` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Sync refuses the spec (nothing is written) when
a vault reference appears anywhere else:

- inside a longer value (`"Bearer ${vault:k}"`), in `command`, `args`, `url`, `headers`, or anywhere
  in `overrides.<agent>.extra` (passed to the agent as written, so it would reach its config);
- in a remote server (agents connect to it directly, so there is no process to give it to);
- in a server whose `command` or `args` holds any reference (`${env:...}`), because a grant binds
  the exact command line the agent will pass;
- in a server whose `command` is not an absolute path, because a grant binds the program itself and
  a `PATH` lookup could pick a different one.

## What sync writes

Every agent's entry for that server becomes:

```json
{
  "command": "/Users/me/.local/bin/sync-agents",
  "args": ["exec", "--keep", "LOG_LEVEL", "--vault", "GITHUB_TOKEN=github", "--", "/opt/tools/github-mcp", "--stdio"],
  "env": { "LOG_LEVEL": "info" }
}
```

The other `env` entries stay in the config and are passed through with `--keep`. Neither the value
nor the `${vault:...}` reference appears in any target config. The command is
`$AGENT_HUB_EXEC_PATH` when that is an absolute path, otherwise `~/.local/bin/sync-agents` (where
`install.sh` puts its link). Changing `AGENT_HUB_EXEC_PATH` changes every compiled entry, so set
it the same way for every sync.

## Storing a value and granting it

```bash
printf '%s' "$TOKEN" | sync-agents secret set github      # the value is read from stdin
sync-agents secret grant github --to github-mcp           # reads the hub's spec for that server
sync-agents secret list                                   # grants, never values
sync-agents secret revoke github [--to github-mcp]
```

- `secret set` stores the value in the keychain (service `agent-hub`, account `KEY`). The value is
  handed to `/usr/bin/security -i` on its standard input, hex-encoded, so it is never in any
  process's argv. Values must be printable ASCII; one trailing newline is dropped.
- `secret grant KEY --to SERVER` records, for every agent whose resolved spec uses `KEY`: the key,
  the variable, the exact argv (the server's `command` followed by its `args`), the **real path**
  of the program (`command` resolved through symlinks, now), and the exact set of other `env`
  names the agent passes through (`--keep`). The grant fails if the program does not exist.
  Grants live in `$XDG_STATE_HOME/agent-hub/grants.json` (default `~/.local/state/agent-hub/`),
  mode 0600.
- After changing a vault server's `command`, `args` or `env` names, or after its command (or a
  symlink on the way to it) is pointed at a different file, grant it again: the old grant no
  longer matches, and exec refuses. Concurrent `grant` and `revoke` runs are serialized with a
  lock, so none is lost.

Each command prints `agent_hub.grant` lines for the grants it made, removed or listed, and ends
with an `agent_hub.summary` line (see [output](../output/README.md)).

## What `exec` does

`sync-agents exec [--keep NAME]... --vault ENV=KEY... -- COMMAND [ARGS...]`:

1. `COMMAND` must be an absolute path to an existing program. Every `--vault ENV=KEY` must match
   a grant with that key and variable, exactly this `COMMAND ARGS`, the same real path of
   `COMMAND`, and exactly this set of `--keep` names. If any does not, exec refuses (exit 1)
   **before reading anything** from the keychain.
2. Reads each value with `security find-generic-password -s agent-hub -a KEY -w`, into memory.
3. Builds a new environment from only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`,
   `LC_ALL`, `LC_CTYPE`, `TERM`, `TZ`, the `--keep` names, and the secrets.
4. Appends a line to `$XDG_STATE_HOME/agent-hub/exec-audit.jsonl` (mode 0600). An exec that cannot
   write its audit line does not run.
5. Replaces itself with the program at that real path through `execve(2)`, with `COMMAND ARGS` as
   its argv. The server has exec's PID: no wrapper process
   stays behind holding the secret, and killing the server (even with SIGKILL) leaves nothing
   orphaned.

On success exec prints nothing, since stdout then belongs to the server. Every failure is one
`agent_hub.error` line on stderr (code `usage` for bad arguments, `config` for a refused or
unreadable grant or a missing keychain item, `internal` otherwise), and never on stdout.

The audit line holds the time, PID, outcome (`exec`, `refused` or `error`), argv, the real
program path, the `(env, key)` pairs and, for a refusal or error, a reason. If `execve` itself
fails after an `exec` line, a second line with outcome `error` follows. It never holds a value. Its schema is
[`schemas/files/agent_hub.exec_audit.schema.json`](../../../schemas/files/agent_hub.exec_audit.schema.json).

## Platforms

The vault uses the macOS keychain through `/usr/bin/security`. On other platforms `secret set` and
an exec that reaches step 2 fail with a `config` error. `AGENT_HUB_SECURITY_BIN` (an absolute path)
replaces `/usr/bin/security`; the test suite uses it to run a fake, and so can you to plug in a
compatible tool.

## Threat model

The vault is for **one user on one machine**. What it does and does not protect:

- **Protected:** secrets in agent config files, hub files, dotfile repositories and backups of
  them. None of those holds a value or anything that resolves to one without the keychain.
- **Protected:** what runs with the secret, against an edited agent config. A grant binds the
  exact argv, the program's real path and the pass-through variable set, so an agent config edited
  to run a different program, the same program with other arguments, a relative command that
  `PATH` would resolve elsewhere, or the same command with an extra pass-through variable (such as
  `BASH_ENV`, `NODE_OPTIONS` or `DYLD_INSERT_LIBRARIES`) is refused, as is an exec that moves a
  granted key into a different variable.
- **Not protected:** a change to the program file itself (or to what it loads) at the granted
  path. The grant binds the path, not the file's contents. `PATH`, `HOME` and the other allowlisted
  variables are passed through from the agent and can still affect what the program does.
- **Not protected: code running as you.** Any process with your user ID can run `security
  find-generic-password` itself, edit `grants.json`, or set `AGENT_HUB_SECURITY_BIN`. The keychain
  may prompt the first time a new program reads an item; agent-hub does not rely on that.
- **Not protected:** the server process. Once exec has replaced itself, the secret is in the
  server's environment, readable by anything that can read that process's environment (the same
  user, or root).
- **Not protected:** what the server does with the value, including logging it.

An `exec-audit.jsonl` line is a record, not a control: a process running as you can also edit it.
