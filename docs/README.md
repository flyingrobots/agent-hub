# agent-hub documentation

This is the routing index. Each page below describes behavior that exists on `main`; each
topic's `test-plan.md` is the contract ledger that ties those statements to tests.

Start with the [README](../README.md) for installation and a first sync.

## Topics

| Topic | Reference | Contract ledger | Read it when |
| --- | --- | --- | --- |
| Sync and targets | [sync/README.md](topics/sync/README.md) | [sync/test-plan.md](topics/sync/test-plan.md) | You want to know what `sync-agents` writes where, how to scope a run, or how to upgrade |
| MCP servers | [mcp/README.md](topics/mcp/README.md) | [mcp/test-plan.md](topics/mcp/test-plan.md) | You are writing a canonical `mcp.json`, or a target config was refused |
| Installing and releasing | [install/README.md](topics/install/README.md) | [install/test-plan.md](topics/install/test-plan.md) | You are installing from source or a release binary, switching layouts, or cutting a release |
| Importing | [import/README.md](topics/import/README.md) | [import/test-plan.md](topics/import/test-plan.md) | You already have servers, rules or skills in your agents and want them in the hub |
| Vault secrets | [vault/README.md](topics/vault/README.md) | [vault/test-plan.md](topics/vault/test-plan.md) | A stdio server needs a secret and you want it out of every config file |
| Project mode | [project/README.md](topics/project/README.md) | [project/test-plan.md](topics/project/test-plan.md) | You want a repository's own `.agents/` synced into its `.mcp.json`, `AGENTS.md` and friends, or you are reviewing a `sync.lock.json` change |
| Commands and agents | [primitives/README.md](topics/primitives/README.md) | [primitives/test-plan.md](topics/primitives/test-plan.md) | You want one slash command or subagent in every agent |
| Output | [output/README.md](topics/output/README.md) | [output/test-plan.md](topics/output/test-plan.md) | You are parsing `sync-agents` output, or want prose with `--human` |
| Ownership and recovery | [ownership/README.md](topics/ownership/README.md) | [ownership/test-plan.md](topics/ownership/test-plan.md) | You need to know what `sync-agents` considers its own, how it recovers from interruption, or how to migrate legacy v1 state |

## Other records

- [GLOSSARY.md](../GLOSSARY.md): the project's terms, and the words to avoid for each.
- [CHANGELOG.md](../CHANGELOG.md): what changed in each release.
- [ADR 0001](adr/0001-machine-overrides-live-outside-the-hub.md): why machine overrides live outside the hub.
- GitHub issues carry planned work, in the `issue-dag/2` format read by the
  issue templates in [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/config.yml).
  Planned behavior never appears in a topic reference.

## Checking the docs

`bun test test/docs.test.ts` fails if a relative link or heading anchor in `README.md`,
`CHANGELOG.md` or `docs/` does not resolve, if a test cited in a `test-plan.md` does not exist
with that exact name, or if a page under `docs/` is not linked from this index.
