# Sync and targets: test plan

Contract ledger for [Sync and targets](README.md). Each requirement names its oracle and the
test that checks it, written as `<file> › <exact test name>` under `test/`. The documentation
gate (`test/docs.test.ts`) fails if a cited test does not exist.

Evidence types: **E2E** runs the real `bin/sync-agents` in a sandbox `HOME`; **unit** calls a
module directly.

## Hub resolution

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| SYNC-HUB-1 | The hub resolves from `--dir`, then `$AGENTS_DIR`, then `config.json` `agentsDir`, then `~/.agents` | `--print-dir` output per layer (answered by the `bin/sync-agents` wrapper, not the TypeScript resolver sync uses) | E2E | Implemented | `agent-hub.test.ts › resolves hub directory with precedence: --dir > AGENTS_DIR > config.json > ~/.agents` |
| SYNC-HUB-3 | `src/cli.ts --print-dir` and the wrapper agree when `disabledTargets` is invalid | Same printed hub | E2E | Implemented | `followups.test.ts › bin/sync-agents --print-dir and src/cli.ts --print-dir agree when disabledTargets is invalid` |
| SYNC-HUB-2 | A relative `--dir` is canonicalized, so links are absolute and `--check` works from any working directory | Link targets absolute; `--check` from another CWD exits 0, and 1 once a link breaks | E2E | Implemented | `agent-hub.test.ts › Contract 7 (MUST #6): relative --dir hub canonicalizes to absolute links and --check catches broken links across CWDs` |

## Links and skills

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| SYNC-LINK-1 | Rules and skills are linked into every target whose root exists; tool-owned directories are preserved; removed skills are pruned | Symlinks present, `.system` dir untouched, link gone after hub removal (checked with `lstat`) | E2E | Implemented | `agent-hub.test.ts › installs skills, preserves tool-owned dirs, compiles MCP configs, passes --check, and prunes cleanly` |
| SYNC-LINK-6 | OpenCode links and MCP config follow `$XDG_CONFIG_HOME` | Links and `opencode.json` under the XDG base; `--check` 0 | E2E | Implemented | `followups.test.ts › OpenCode links and MCP follow $XDG_CONFIG_HOME, as OpenCode itself does` |
| SYNC-LINK-7 | A symlinked `XDG_CONFIG_HOME` that names `~/.config` causes no churn or conflict after a default-base sync | `--check` 0 with no conflict; links kept after `--adopt` | E2E | Implemented | `followups.test.ts › a symlinked XDG_CONFIG_HOME naming ~/.config causes no churn or conflicts after a default-base sync` |
| SYNC-LINK-8 | A relative `XDG_CONFIG_HOME` is ignored | Links under `~/.config/opencode`, none under the relative path | E2E | Implemented | `followups.test.ts › a relative XDG_CONFIG_HOME is ignored, as the XDG spec requires` |
| SYNC-LINK-9 | With a symlinked `~/.config`, XDG unset and `XDG_CONFIG_HOME=$HOME/.config` are interchangeable in either order | `--check` 0 with no conflict; links kept | E2E | Implemented | `followups.test.ts › symlinked ~/.config: XDG unset then $HOME/.config is zero-conflict and keeps every link` |
| SYNC-LINK-10 | A `HOME` reached through a symlinked alias syncs with no conflict after a canonical-`HOME` sync | `--check` 0; links and MCP kept | E2E | Implemented | `followups.test.ts › a HOME given through a symlinked alias syncs with zero conflicts after a canonical-HOME sync` |
| SYNC-LINK-14 | After a run under a new spelling, link and MCP records carry it; removing the old alias then causes no conflict | Record keys and `configPath`; `--check` 0 after the alias is gone | E2E | Implemented | `rekey.test.ts › after a run under a new spelling, link and MCP records carry it; removing the old alias then causes no conflict` |
| SYNC-LINK-15 | A re-key is ledger-only and done once | Target bytes unchanged; next run in sync | E2E | Implemented | `rekey.test.ts › a re-key is ledger-only: no target file changes` |
| SYNC-LINK-16 | A scoped run re-keys only the active targets' records | Per-target record spellings | E2E | Implemented | `rekey.test.ts › a scoped run re-keys only the active targets' records` |
| SYNC-LINK-17 | Two desired links with one physical path are one object: the first run succeeds, later runs neither re-key nor churn | Exit 0 on run 1; runs 2-4 in sync with stable keys | E2E | Implemented | `rekey.test.ts › two desired links with one physical path: the first run succeeds and later runs neither re-key nor churn` |
| SYNC-LINK-18 | Splitting a shared directory afterwards leaves both links agent-hub's, whichever side is the symlink | No conflict; both links exist | E2E | Implemented | `rekey.test.ts › after the shared directory is split, the link agent-hub made is still its own (no unmanaged conflict)`, `rekey.test.ts › splitting the symlinked side leaves both links agent-hub's, in both directions` |
| SYNC-LINK-19 | A scoped run never moves another target's record | The other target's record keeps its key | E2E | Implemented | `rekey.test.ts › a scoped run never moves another target's record into its own spelling` |
| SYNC-LINK-20 | `--check` lists no re-keys; a record removed in the same run is reported only as removed | No re-key lines; `mcp-prune` for the removed server | E2E | Implemented | `rekey.test.ts › --check prints no re-key lines; a record pruned in the same run is not reported as re-keyed` |
| SYNC-LINK-11 | A relative `XDG_STATE_HOME` is ignored; the ledger stays under `~/.local/state` | Ledger path | E2E | Implemented | `followups.test.ts › a relative XDG_STATE_HOME is ignored, as the XDG spec requires (Baker Street PR #18 blind pass B-F-3)` |
| SYNC-LINK-2 | Unsafe skill sources (escaping, absolute or cyclic symlinks) are refused with no hub change | Exit 1, message, skill absent from hub | E2E | Implemented | `hardening.test.ts › F3 & F12: cyclic symlinks and escaping/absolute symlinks in skills & archives are rejected safely` |
| SYNC-LINK-3 | A failed skill install leaves no staging directories in the hub | No `.staging-*` entries | Unit | Implemented | `hardening.test.ts › F4: applySkillInstall cleans up .staging-* on mid-install failure (zero leaks in <hub>/skills)` |
| SYNC-LINK-4 | The skill name comes from `SKILL.md` frontmatter, including quoted values and inline comments | Installed directory name | E2E | Implemented | `hardening.test.ts › F10: YAML frontmatter name parses inline comments and quoted scalars cleanly` |
| SYNC-LINK-5 | A local source path starting with `-` is a path, not a flag | Install succeeds | E2E | Implemented | `hardening.test.ts › F11: local skill source filename starting with '-' is not parsed as a CLI flag` |
| SYNC-LINK-21 | A shared link's record lives under the spelling with no symlink in its path | Ledger key | E2E | Implemented | `rekey.test.ts › the shared link's record lives under the spelling with no symlink in its path, whichever side sorts first` |
| SYNC-LINK-22 | A record left under the symlinked spelling moves to the physical one | Ledger keys; no conflict after the split | E2E | Implemented | `rekey.test.ts › a record an earlier run left under the symlinked spelling moves to the physical one` |
| SYNC-LINK-23 | With HOME reached through an alias, the record lives under the spelling with fewer symlinks; a later split is clean | Ledger key; no conflict | E2E | Implemented | `rekey.test.ts › with HOME reached through an alias, the record still lives under the spelling with fewer symlinks` |
| SYNC-LINK-24 | A scoped run never moves another target's record into its own physical spelling | Record key kept; no re-key | E2E | Implemented | `rekey.test.ts › a scoped run never moves another target's record into its own physical spelling` |

## Machine instructions

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| SYNC-MI-1 | A machine instructions file points every rules link at a generated file holding a notice, the hub text, then the machine text | Link targets; generated file bytes; `--check` 0 | E2E | Implemented | `machine-instructions.test.ts › a machine instructions file points every rules link at a generated file: notice, hub text, then machine text` |
| SYNC-MI-2 | No machine file, or a whitespace-only one, links the hub `AGENTS.md` and writes no generated file | Link target; generated file absent | E2E | Implemented | `machine-instructions.test.ts › no machine file, or a whitespace-only one, links the hub AGENTS.md and writes no generated file` |
| SYNC-MI-3 | After the hub or the machine file changes, `--check` exits 1 naming the generated file; a sync regenerates it | Exit codes; output names the file; new text present | E2E | Implemented | `machine-instructions.test.ts › editing the hub or the machine file makes --check fail naming the generated file, and a sync regenerates it` |
| SYNC-MI-4 | Removing the machine file points rules links back at the hub and removes the generated file | Link targets; generated file absent; `--check` 0 | E2E | Implemented | `machine-instructions.test.ts › removing the machine file points the rules links back at the hub and removes the generated file` |
| SYNC-MI-5 | A generated file deleted by hand is recreated | File bytes; link target; `--check` 0 | E2E | Implemented | `machine-instructions.test.ts › a generated file deleted by hand is recreated by the next sync` |
| SYNC-MI-6 | `--dry-run` and `--explain` name the machine file and write nothing | Output; generated file and links absent | E2E | Implemented | `machine-instructions.test.ts › --dry-run and --explain name the machine instructions file and write no generated file` |
| SYNC-MI-7 | A scoped run keeps a generated file an excluded target's rules link points at | Link targets; file present until an unscoped run | E2E | Implemented | `machine-instructions.test.ts › a scoped run never removes a generated file an excluded target's rules link still points at` |
| SYNC-MI-8 | The machine file follows `$XDG_CONFIG_HOME` | Generated text from the XDG file only | E2E | Implemented | `machine-instructions.test.ts › the machine instructions file follows $XDG_CONFIG_HOME` |
| SYNC-MI-9 | Project mode ignores machine instructions | Output does not name the machine file; project link unchanged | E2E | Implemented | `machine-instructions.test.ts › --project ignores the machine instructions file` |

## Installer

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| SYNC-INST-1 | `install.sh` installs an isolated runtime with its marker and the result passes `--check` | Marker present; `--check` exit 0 | E2E | Implemented | `agent-hub.test.ts › install.sh creates isolated install with .agent-hub-runtime marker and passes --check` |
| SYNC-INST-2 | `install.sh` never passes `--force`, scopes `--force-skill`, and guards the prefix and shim | Exit codes and preserved files per case | E2E | Implemented | `agent-hub.test.ts › Contract 3 (MUST #2 + SHOULD #4): installer never supplies global force, scopes --force-skill, and guards --prefix & shim` |
| SYNC-INST-3 | Relative shim resolution, missing-argument exit 2, `--opt=val`, and an atomic runtime swap | Per case | E2E | Implemented | `hardening.test.ts › F7 & F8 & F13: install.sh relative shim resolution, missing-arg exit 2, --opt=val, and atomic swap` |

## Read-only modes

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| SYNC-RO-1 | `--check`, `--dry-run` and `--explain` create no lock, state or journal file | State dir contents unchanged | E2E | Implemented | `recovery.test.ts › read-only --check, --dry-run, and --explain create zero lock, state, or journal artifacts` |
| SYNC-RO-2 | `--dry-run` and `--explain` honor `--targets` and change nothing | Output names only the selected target; files unchanged | E2E | Implemented | `adapters.test.ts › R-4c: --dry-run and --explain honor --targets and change nothing` |

## Target scoping

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| SYNC-SCOPE-1 | `--targets` and `disabledTargets` skip excluded targets and never prune them; `--targets` replaces `disabledTargets`; an unknown `--targets` name exits 2 | Excluded link, MCP entry and ledger record unchanged after hub removal | E2E | Implemented | `adapters.test.ts › --targets and config disabledTargets skip untargeted adapters and NEVER prune them` |
| SYNC-SCOPE-2 | An invalid `disabledTargets` (unknown name, non-array) exits 1 and mutates no target | Exit code, message, target bytes | E2E | Implemented | `adapters.test.ts › R-4a: invalid disabledTargets (unknown name, non-array) fails closed without mutating any target` |
| SYNC-SCOPE-3 | Selectors mix whole targets and single domains | Per-target links and MCP entries match the selection | E2E | Implemented | `adapters.test.ts › --targets mixes whole targets and single domains` |
| SYNC-SCOPE-4 | An unknown domain exits 2 from `--targets` and 1 from `config.json` | Exit codes and message | E2E | Implemented | `adapters.test.ts › unknown domain is rejected: exit 2 from --targets, exit 1 from config` |
| SYNC-SCOPE-5 | `"<target>:mcp"` disabled keeps that target's links syncing past a refused MCP config | Links created; `.jsonc` untouched; `--check` exits 0 | E2E | Implemented | `adapters.test.ts › disabledTargets ["opencode:mcp"] keeps OpenCode links syncing past an opencode.jsonc` |
| SYNC-SCOPE-6 | A scoped run keeps link records it cannot attribute to a target under the current `HOME` | Record and link survive | E2E | Implemented | `adapters.test.ts › restricted --targets sync never prunes link records whose owning target cannot be resolved` |
| SYNC-SCOPE-7 | Ownership is never inferred from an overlapping earlier `HOME` | Claude link under old `HOME=~/.cursor` survives `--targets cursor` | E2E | Implemented | `adapters.test.ts › a Claude link recorded under an old HOME nested in ~/.cursor survives a --targets cursor run` |
| SYNC-SCOPE-8 | A scoped run still prunes the active target's own stale links | Cursor link gone (by `lstat`), Claude link kept, scoped `--check` 0, unscoped `--check` 1 | E2E | Implemented | `adapters.test.ts › --targets cursor:links prunes a removed skill from Cursor and keeps Claude's` |
| SYNC-SCOPE-10 | A repeated `--targets` flag exits 2 | Exit code, message | E2E | Implemented | `followups.test.ts › a repeated --targets flag is a usage error (exit 2), not silently last-wins` |
| SYNC-SCOPE-11 | Excluded agents are absent from the compiled server map, so they can never be read as disabled | Map keys | Unit | Implemented | `followups.test.ts › the compiled server map has no entry for an inactive agent` |
| SYNC-SCOPE-12 | `--skill-only` with `--disown-legacy` exits 2 | Exit code, message | E2E | Implemented | `followups.test.ts › --skill-only with --disown-legacy is a usage error, not a silent success (Baker Street PR #18 M-F-4)` |
| SYNC-SCOPE-9 | Re-enabling an excluded target catches up its missed prunes | Next run prunes the removed server and skill | E2E | Implemented | `followups.test.ts › SYNC-SCOPE-9: re-enabling an excluded target catches up the prunes it missed` |

## Upgrade

| ID | Requirement | Oracle | Evidence | Status | Test |
| --- | --- | --- | --- | --- | --- |
| SYNC-UP-1 | A three-target v2 ledger loads and syncs with zero churn | State bytes and generation unchanged | E2E | Implemented | `adapters.test.ts › backward-compatible loading of existing 3-agent v2 ledger causes zero churn` |
| SYNC-UP-2 | Zero churn also holds when `~/.cursor` and `~/.config/opencode` already exist, under the three legacy targets | State bytes unchanged | E2E | Implemented | `followups.test.ts › zero churn for a three-target ledger when ~/.cursor and ~/.config/opencode already exist` |
