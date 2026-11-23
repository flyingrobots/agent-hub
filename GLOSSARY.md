# agent-hub

The language of agent-hub: one directory of agent configuration that a person edits, and the
`sync-agents` command that projects it into each AI coding agent on a machine.

## Language

### What is configured

**Hub**:
The one directory a person edits, holding the instructions, skills, MCP server definitions, commands and subagents shared by every agent.
_Avoid_: canonical directory, agents dir, dotfiles

**Agent**:
An AI coding application a person runs: Claude Code, Codex, Antigravity, Cursor or OpenCode.
_Avoid_: tool, client, adapter

**Target**:
An agent as a place `sync-agents` writes to, addressed by a selector such as `codex` or `codex:mcp`.
_Avoid_: adapter, destination

**Subagent**:
A definition in the hub's `agents/` directory that an agent can delegate work to.
_Avoid_: agent, agent definition

### How configuration moves

**Sync**:
Projecting the hub into the targets on one machine. It runs in one direction only, from hub to targets.
_Avoid_: bidirectional sync, push, deploy

**Import**:
Bringing everything the agents already have into the hub.
_Avoid_: reverse sync, sync back

**Pull**:
Bringing one server or skill from one agent into the hub.
_Avoid_: reverse sync, sync back

Keeping the hubs on two machines alike is not an agent-hub operation. A hub is a git repository, and git moves it.

### What may be changed

**Owned**:
Recorded in the ledger as written by `sync-agents`, which is the only thing a sync may change or delete.
_Avoid_: managed, tracked

**Unowned**:
Present in a target but not recorded in the ledger, and so left alone.
_Avoid_: unmanaged, personal, foreign

**Adopt**:
To record as owned something `sync-agents` did not write but which is identical to what it would write.
_Avoid_: claim, take over
