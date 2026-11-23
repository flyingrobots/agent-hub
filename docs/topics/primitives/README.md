# Commands and agents

Write a slash command or a subagent once in the hub, and `sync-agents` generates it into each
agent that has a user directory for it, in that agent's own format:

```text
<hub>/commands/<name>.md     a slash command
<hub>/agents/<name>.md       an agent definition (subagent)
```

`<name>` must match `^[a-z0-9][a-z0-9-]*$`; it becomes each agent's file name and command name.
A `README.md` and anything that is not a regular `.md` file are ignored. Frontmatter must start
on the first line (`---`) and close with a `---` line, and the body may not open with another
`---` line (an agent would read it as frontmatter); line endings and a leading BOM are
normalised first, and written files use LF.

## What each agent receives

| Agent | Commands | Agents |
| --- | --- | --- |
| `claude` | `~/.claude/commands/<name>.md`: `description`, `argument-hint` | `~/.claude/agents/<name>.md`: `name`, `description`, `model: inherit` |
| `opencode` | `${XDG_CONFIG_HOME:-~/.config}/opencode/commands/<name>.md`: `description` | `…/opencode/agents/<name>.md`: `description`, `mode: subagent` |
| `cursor` | `~/.cursor/commands/<name>.md`: the body only (plain Markdown) | `~/.cursor/agents/<name>.md`: `name`, `description` |
| `codex` | none (`~/.codex/prompts` is deprecated in favour of skills) | `~/.codex/agents/<name>.toml`: `name`, `description`, `developer_instructions` |
| `antigravity` | none | none |

An agent is skipped when its root directory (`~/.claude`, `~/.cursor`, `~/.codex`,
`…/opencode`) does not exist. Commands and agents belong to a target's `links` domain, with its
rules and skills: `--targets claude:links` includes them, `--targets claude:mcp` does not.

These locations and formats come from the agents' documentation and source as of 2026-11
(Claude Code slash commands and subagents docs; OpenCode `packages/opencode` config loader;
Cursor commands and agents docs; Codex custom prompts and agents docs). Antigravity's agent
directory is not documented well enough to write to. Cursor also reads `~/.claude/agents/`, so it
sees a Claude copy too; its own copy wins on a name clash.

## A command

```markdown
---
description: Review the current diff
argument-hint: "[focus]"
---
Review the changes, focusing on $ARGUMENTS.
```

Portable frontmatter: `description` and `argument-hint` (Claude only shows the hint). Use
`$ARGUMENTS` for what the user typed. A command is refused, for every agent, if it uses:

- a positional placeholder (`$1`, `$2`…): Claude counts from `$0`, OpenCode and Codex from `$1`;
- shell injection in the body (`` !`cmd` ``);
- any other top-level frontmatter key, such as `allowed-tools` or `model`: tool names, model
  names and permissions differ between agents.

Put such a key under `targets.<agent>` to give it to that agent only:

```markdown
---
description: Deploy
targets:
  claude:
    allowed-tools: Bash(git push:*)
---
Deploy now.
```

`targets.cursor` is refused for commands, because Cursor commands take no frontmatter.

## An agent

```markdown
---
description: A careful code reviewer
model: inherit
---
You review code for correctness.
```

`description` is required (agents pick a subagent by it) and the body is its instructions.
`model` may only be `inherit`; any other key, `tools` included, is refused at the top level
(dropping a tool list would widen what the agent may do), and belongs under `targets.<agent>`.
For Codex, `targets.codex` values must be strings, numbers or booleans.

## Ownership

Generated files are owned like MCP entries, by the digest of what was written:

- a file `sync-agents` wrote and nobody changed is updated when the hub changes, and deleted
  when the command or agent leaves the hub;
- an identical file it did not write is a conflict until you pass `--adopt`;
- a different file it did not write, or one edited since it was written, is a conflict;
  `--force` replaces (or deletes) it.

Each write is journaled, so an interrupted run is finished by the next one.

A run is refused, before anything is written, when an agent's `commands` or `agents` directory is
a symlink into the hub (writing there would overwrite the hub's own files), or when two agents'
directories are the same directory (each agent needs its own format). Make each a real
directory. A destination that is itself a symlink or a directory is refused, even with
`--force`.

For Codex, `targets.codex` may not set `name`, `description` or `developer_instructions`; other
keys are quoted when they are not bare TOML keys, numbers must be finite (integers beyond 64
bits are written as floats), and every generated file is parsed before it is written.

An older `sync-agents` ignores the ledger's `files` section and drops it on its next write. After
upgrading again, the files it generated are reported as unmanaged until `--adopt` records them.
