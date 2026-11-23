# Vault secrets: test plan

Contract ledger for [vault secrets and `sync-agents exec`](README.md).

| ID | Requirement | Oracle | Level | Status | Test |
| --- | --- | --- | --- | --- | --- |
| VAULT-DENY-1 | An ungranted exec is refused before the keychain is read | Exit 1; one error line; keychain argv log unchanged; audit `refused` | E2E | Implemented | `vault-exec.test.ts › an ungranted exec is refused before any secret is read` |
| VAULT-EXEC-1 | A granted exec keeps the PID, gets the secret and `--keep` names, and nothing else | Server output; audit line | E2E | Implemented | `vault-exec.test.ts › a granted exec replaces the process with the secret in a scrubbed env, and audits it` |
| VAULT-DENY-2 | An argv that differs from the grant is refused | Exit 1; no value printed | E2E | Implemented | `vault-exec.test.ts › an exec whose argv differs from the grant is refused` |
| VAULT-DENY-3 | A granted key in a different variable is refused | Exit 1 | E2E | Implemented | `vault-exec.test.ts › an exec that puts a granted key in a different variable is refused` |
| VAULT-KILL-1 | SIGKILL of the server leaves no orphan | `ps`/`pgrep` | E2E | Implemented | `vault-exec.test.ts › the exec'd server is the process itself, so SIGKILL leaves no orphan` |
| VAULT-SET-1 | `secret set` passes the value on stdin, hex-encoded, never in argv | Fake `security` logs | E2E | Implemented | `vault-exec.test.ts › secret set passes the value on stdin, never in argv` |
| VAULT-SYNC-1 | Sync compiles `${vault:KEY}` to an exec entry; no config holds the value or reference; the entry runs | Config contents; `--check` 0; run | E2E | Implemented | `vault-exec.test.ts › sync compiles a vault reference to an exec wrapper; no target config holds the secret or the reference` |
| VAULT-REF-1 | A vault reference outside a whole stdio env value is refused at sync | Exit non-zero; no config written | E2E | Implemented | `vault-exec.test.ts › a vault reference outside a stdio env value is refused at sync` |
| VAULT-OUT-1 | exec and secret errors are schema'd stderr lines; stdout stays empty | Decoded output | E2E | Implemented | `vault-exec.test.ts › exec and secret errors are schema'd lines on stderr, never on stdout` |
| VAULT-REV-1 | `secret revoke` removes the grant | Exec refused again | E2E | Implemented | `vault-exec.test.ts › secret revoke removes the grant, and exec is refused again` |
| VAULT-LIST-1 | `secret list` prints grants, never values | `agent_hub.grant` lines | E2E | Implemented | `vault-exec.test.ts › secret list shows grants and never values` |
| VAULT-AUD-1 | Every audit line validates against its schema | Ajv | E2E | Implemented | `vault-exec.test.ts › every exec-audit.jsonl line validates against schemas/files/agent_hub.exec_audit.schema.json` |
| VAULT-BIN-1 | `execve` FFI works inside the compiled binary | Same PID; secret in env | Binary | Implemented | `binary.test.ts › execve FFI inside the binary: a granted exec becomes the server with the same PID (flyingrobots/agent-hub#10)` |
