---
status: accepted
---

# Machine overrides live outside the hub

One hub is cloned on several machines, and three things differ between them that the hub could not express: a home directory inside a server's `command`, a program installed on one machine only, and an unowned entry in one agent that has a hub server's name. We decided that each machine states its own differences in a **machine override** file under `${XDG_CONFIG_HOME:-~/.config}/agent-hub/`, applied on top of the hub when syncing, because the hub must stay free of anything machine-specific and a shared repository should not name the machines that use it.

Decided with the maintainer on 2026-11-23 (flyingrobots/agent-hub#55). Not yet implemented.

## Considered options

- **Host-keyed blocks inside the hub.** Rejected: it puts machine names in a shared file, breaks when a machine is renamed, and contradicts the rule that nothing machine-specific is written into the hub.
- **A home reference in the hub format** (`${home}` in `command`). Rejected for now: it changes the canonical format, which is hard to withdraw, and `import` could no longer read an absolute path back into exactly the text the hub holds. It also solves only the first of the three cases. Revisit if most machine overrides turn out to be home paths.
- **A per-server opt-out list in `config.json`.** Rejected: it covers disabling but not a changed `command`, so a second mechanism would still be needed.
- **Document the `/bin/sh -c 'exec "$HOME/…"'` idiom and do nothing else.** Rejected: it leaves the missing-program and name-clash cases with no remedy short of excluding a whole target's MCP domain.

## Consequences

- **Scope.** A machine override changes MCP servers the hub already defines. It cannot add a server, and it does not reach skills, commands or subagents. Instructions vary per machine through a separate file; see [ADR 0002](0002-machine-instructions-extend-the-hub-rules.md). A server that exists on one machine only stays an unowned entry in that agent.
- **Shape and precedence.** A machine override for a server has the shape of that server's own `mcp.json` (a base and target overrides) and is layered last: hub base, hub target overrides, machine base, machine target overrides. It can change fields, disable the server on this machine, or disable it for one target.
- **Name clash.** A server disabled for a target by a machine override is not planned for that target, so an unowned entry of the same name there is left alone and is not a conflict. An entry `sync-agents` owns is removed, as when the hub disables it.
- **In sync means hub plus machine overrides.** `--check` compares targets with the hub as modified on this machine. So that an override never hides silently, `--explain` and `--dry-run` name the machine override as the reason for each server it changes or omits, and the summary counts the overrides in effect.
- **Import and pull never write a machine override.** `pull --as-override` still writes a target override into the hub. An agent entry that differs from the hub only by this machine's override is in sync, not something to pull.
- **Project mode ignores machine overrides**, as it ignores `config.json`, so committed outputs are the same in every clone.
- **Failure.** A malformed machine override file fails every run that reads it, like a malformed `config.json`; project mode does not read it. An override naming a server the hub does not have is a warning, not an error, so removing a server on one machine does not break the next sync on another.
- **Secrets.** The plaintext-secret check applies to machine overrides as it does to the hub.
- **Invisible elsewhere.** A machine's overrides are not versioned with the hub and cannot be seen from another machine. `disabledTargets` stays as the coarser tool.
