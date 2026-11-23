# Project mode: test plan

Contract ledger for [project mode](README.md).

| ID | Requirement | Oracle | Level | Status | Test |
| --- | --- | --- | --- | --- | --- |
| PROJ-GOLD-1 | Project sync writes the known outputs and a sorted, machine-independent lockfile; `--check` 0 after | File contents, link targets, lock keys and digests | E2E | Implemented | `project.test.ts › project sync writes the known outputs and a sorted, machine-independent lockfile` |
| PROJ-CLONE-1 | A git clone passes `--project --check` with a byte-identical lockfile; cwd toplevel resolution | Real git init, commit, clone; exit 0 | E2E | Implemented | `project.test.ts › a git clone of a synced repo passes --project --check with a byte-identical lockfile` |
| PROJ-MOVE-1 | A moved repo still passes `--check` | cp -a, exit 0 | E2E | Implemented | `project.test.ts › a repo moved to another path still passes --project --check` |
| PROJ-REPO-1 | Outside a git repository without `--dir`, a `config` error | Error line | E2E | Implemented | `project.test.ts › outside a git repository without --dir, project mode fails with a config error` |
| PROJ-LOCK-1 | Hostile lock entry (parent escape) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: parent escape` |
| PROJ-LOCK-2 | Hostile lock entry (absolute path) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: absolute path` |
| PROJ-LOCK-3 | Hostile lock entry (dot-dot segment) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: dot-dot segment` |
| PROJ-LOCK-4 | Hostile lock entry (git hook) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: git hook` |
| PROJ-LOCK-5 | Hostile lock entry (package.json) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: package.json` |
| PROJ-LOCK-6 | Hostile lock entry (hub file) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: hub file` |
| PROJ-LOCK-7 | Hostile lock entry (NUL byte) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: NUL byte` |
| PROJ-LOCK-8 | Hostile lock entry (backslash) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: backslash` |
| PROJ-LOCK-9 | Hostile lock entry (file listed as a link) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: file listed as a link` |
| PROJ-LOCK-10 | Hostile lock entry (link with a foreign target) fails closed | Exit 1, `config`; no output written; lock and outside dir unchanged | E2E | Implemented | `project.test.ts › hostile lock entry rejected: link with a foreign target` |
| PROJ-ESC-1 | A lock entry under a symlink escaping the repo is rejected | Exit 1, `config`; outside tree digest unchanged | E2E | Implemented | `project.test.ts › a lock entry under a symlink that escapes the repo is rejected` |
| PROJ-ESC-2 | Never writes through a symlinked output directory | Nothing created outside | E2E | Implemented | `project.test.ts › project mode never writes through a symlinked output directory` |
| PROJ-LOCK-11 | Malformed, wrong-version, extra-key, bad-digest or duplicate-key lockfile fails closed | Exit 1, `config` | E2E | Implemented | `project.test.ts › a malformed or duplicate-key lockfile fails closed` |
| PROJ-PRUNE-1 | Pruning needs an exact digest match; an edited file is kept as a conflict; unedited outputs are pruned | Conflict line; file kept; later prune | E2E | Implemented | `project.test.ts › pruning requires an exact digest match: an edited file is kept and reported as a conflict` |
| PROJ-FUZZ-1 | Validator accepts exactly the known output set over 200+ seeded paths | Independent oracle set | E2E | Implemented | `project.test.ts › the validator accepts exactly the known output set over 200 seeded paths` |
| PROJ-VAL-1 | Known names are accepted only for their kind | Unit | E2E | Implemented | `project.test.ts › the lock entry validator accepts known names only for their kind (flyingrobots/agent-hub#11)` |
| PROJ-OWN-1 | Unmanaged `.mcp.json` is a conflict; `--adopt` adopts identical bytes only | Exit codes; lock digest | E2E | Implemented | `project.test.ts › an unmanaged existing .mcp.json is a conflict; --adopt adopts identical bytes only` |
| PROJ-OWN-2 | User-edited owned file is a conflict; `--force` rewrites | Bytes before and after | E2E | Implemented | `project.test.ts › a user-edited owned file is a conflict; --force rewrites it` |
| PROJ-OWN-3 | Owned, unedited output is rewritten when the hub changes | File contents; `--check` | E2E | Implemented | `project.test.ts › an owned, unedited output is rewritten when the hub changes` |
| PROJ-RELOCK-1 | `--relock` rebuilds the lockfile from identical outputs and never claims differing bytes | Lock bytes; missing entry | E2E | Implemented | `project.test.ts › --relock rebuilds the lockfile from outputs that equal the intended bytes, never claiming others` |
| PROJ-VAULT-1 | Vault server compiles to the bare `sync-agents` launcher; no grant created; `secret grant --dir` binds the inner argv | Config contents; grants.json | E2E | Implemented | `project.test.ts › a vault server compiles to the bare sync-agents launcher and no grant is created` |
| PROJ-SECRET-1 | A plaintext secret literal blocks | Warning + `config` error; nothing written | E2E | Implemented | `project.test.ts › a plaintext secret literal blocks project mode` |
| PROJ-AG-1 | Antigravity is never written | Repo listing | E2E | Implemented | `project.test.ts › Antigravity is never written in project mode` |
| PROJ-SCOPE-1 | `--targets` limits outputs and never prunes excluded agents | Lock entries | E2E | Implemented | `project.test.ts › --targets limits project outputs and never prunes excluded agents` |
| PROJ-HOME-1 | The user's home is byte-identical after sync, check, explain and dry-run | Tree digest | E2E | Implemented | `project.test.ts › project mode leaves the user's home byte-identical` |
| PROJ-PLAN-1 | `--dry-run` and `--explain` plan without writing; `--human` prints prose | Op phases; repo listing | E2E | Implemented | `project.test.ts › --dry-run and --explain plan project outputs without writing` |
