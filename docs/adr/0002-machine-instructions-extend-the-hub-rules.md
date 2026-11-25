---
status: accepted
---

# Machine instructions extend the hub's rules

ADR 0001 kept machine overrides to MCP servers. Instructions turned out to vary between machines too: a section about a service that one machine can reach is wrong, and misleading, on every other. We decided that a machine may add instructions in a **machine instructions** file, `${XDG_CONFIG_HOME:-~/.config}/agent-hub/AGENTS.md`, which `sync-agents` appends to the hub's `AGENTS.md` in a generated rules file that every rules link then points at, because agents read exactly one rules file and the hub must still name no machine.

Requested by the maintainer on 2026-11-24 (flyingrobots/agent-hub#69).

## Considered options

- **Host-keyed sections in the hub `AGENTS.md`.** Rejected for the reason ADR 0001 rejected host-keyed blocks: it names machines in a shared file.
- **Agent-native imports** (Claude Code's `@path`). Rejected: Codex, Cursor and OpenCode would silently lose the instructions.
- **A pointer line in the hub** asking agents to read the machine file if it exists. Rejected: it depends on every agent obeying it, and nothing can check that it did.
- **Writing the merged text into each agent's rules file.** Rejected: it turns managed symlinks into a second kind of owned file with its own ledger records. One generated file behind the existing links needs no ledger change.

## Consequences

- **Additive only.** Machine instructions follow the hub's text; they cannot remove or edit it. They apply to every target alike.
- **No file, no change.** With no machine instructions file, or one holding only whitespace, rules links point at the hub `AGENTS.md` exactly as before, and no generated file exists.
- **The generated file is derived.** It lives in the state directory as `rules-<hub hash>.md`, starts with a notice naming both sources, and is rewritten whenever its bytes differ from what they produce. It is not journaled: it is written atomically, and a run interrupted at any point converges on the next one. It is removed only after the links that point at it have been pointed back at the hub, and never while a link outside the run's `--targets` still points at it.
- **Edits through a rules link are lost.** With a machine file present, `~/.claude/CLAUDE.md` and its siblings lead to the generated file, so editing them changes output that the next sync overwrites. The notice and the docs say to edit the hub or the machine file.
- **Hub edits need a sync.** Through a plain symlink a hub edit reaches agents at once; with a machine file it reaches them at the next sync. `--check` reports the stale generated file, so the gap is visible.
- **Visible.** `--dry-run` and `--explain` name the machine instructions file as the reason for the generated file and for each rules link that points at it.
- **Project mode ignores it**, as it ignores machine overrides, so committed outputs are the same in every clone.
- **ADR 0001 still governs MCP machine overrides.** Its scope line now reads as excluding everything except MCP servers and, through this ADR, instructions.
