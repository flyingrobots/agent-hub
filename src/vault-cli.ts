/** `sync-agents exec` and `sync-agents secret` (Phase 5, flyingrobots/agent-hub#10). */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadCanonicalServers, type VaultInvocation } from "./mcp.ts";
import { writeEvents, type OutputEvent } from "./output.ts";
import {
  addGrants,
  appendAudit,
  BASE_ENV,
  execve,
  findGrant,
  keychainGet,
  keychainSet,
  loadGrants,
  parseExecArgs,
  resolveProgram,
  saveGrants,
  VAULT_KEY,
  VaultError,
  vaultStateDir,
  type ExecRequest,
  type Grant,
} from "./vault.ts";

export const EXEC_USAGE = `Usage: sync-agents exec [--keep NAME]... --vault ENV=KEY... -- COMMAND [ARGS...]

Run COMMAND with each vault KEY in ENV, replacing this process (same PID). Every
--vault pair needs an exact grant for this argv (sync-agents secret grant). The
environment is scrubbed to ${BASE_ENV.join(", ")}, the --keep names and the secrets.
Agents' configs call this; sync writes those entries from \${vault:KEY} in the hub.`;

export const SECRET_USAGE = `Usage: sync-agents secret set KEY            (the value is read from stdin)
       sync-agents secret grant KEY --to SERVER [--dir DIR]
       sync-agents secret revoke KEY [--to SERVER]
       sync-agents secret list

Values live in the macOS keychain (service "agent-hub"). A grant lets SERVER's
exact command line receive KEY in the variable its hub spec names.`;

type Emit = (e: OutputEvent) => void;

const errorEvent = (code: "usage" | "config" | "internal", message: string, extra: Record<string, unknown> = {}): OutputEvent => ({
  stream: "stderr",
  id: "agent_hub.error",
  message,
  data: { code, detail: message, ...extra },
});

const grantEvent = (verb: string, g: Grant): OutputEvent => ({
  stream: "stdout",
  id: "agent_hub.grant",
  message: `[${verb}] ${g.key} -> ${g.env} for ${g.server ? `mcp/${g.server}: ` : ""}${g.argv.join(" ")}`,
  data: { key: g.key, env: g.env, argv: g.argv, ...(g.server ? { server: g.server } : {}) },
});

const summary = (message: string, changes: number): OutputEvent => ({
  stream: "stderr",
  id: "agent_hub.summary",
  message,
  data: { status: "applied", changes, conflicts: 0 },
});

function stateDir(): string {
  return vaultStateDir(homedir(), process.env.XDG_STATE_HOME);
}

// ---------------------------------------------------------------- exec

export function runExecCli(argv: string[], human: boolean): number {
  const emit: Emit = (e) => writeEvents([e], human);
  let req: ExecRequest;
  try {
    req = parseExecArgs(argv);
  } catch (err) {
    emit(errorEvent("usage", `sync-agents exec: ${(err as Error).message}\n${EXEC_USAGE}`, { usage: EXEC_USAGE }));
    return 2;
  }
  const dir = stateDir();
  const audit = (outcome: string, reason?: string) => {
    try {
      appendAudit(dir, { pid: process.pid, outcome, argv: req.argv, vault: req.vault, ...(reason ? { reason } : {}) });
      return true;
    } catch {
      return false;
    }
  };
  // Every pair is checked against a grant before any secret is read.
  let grants: Grant[];
  try {
    grants = loadGrants(dir);
  } catch (err) {
    audit("refused", (err as Error).message);
    emit(errorEvent("config", `sync-agents exec: ${(err as Error).message}`));
    return 1;
  }
  const missing = req.vault.filter((u) => !findGrant(grants, u, req.argv));
  if (missing.length > 0) {
    const what = missing.map((u) => `${u.env}=${u.key}`).join(", ");
    audit("refused", `no grant for ${what} with this argv`);
    emit(
      errorEvent(
        "config",
        `sync-agents exec: refused: no grant for ${what} with this exact command line (grant it with: sync-agents secret grant KEY --to SERVER)`,
      ),
    );
    return 1;
  }
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV, ...req.keep]) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  let program: string;
  try {
    for (const u of req.vault) env[u.env] = keychainGet(u.key);
    program = resolveProgram(req.argv[0]!, env.PATH);
  } catch (err) {
    audit("error", (err as Error).message);
    emit(errorEvent("config", `sync-agents exec: ${(err as Error).message}`));
    return 1;
  }
  // The audit line is written before the process is replaced; an exec that cannot be audited
  // does not run.
  if (!audit("exec")) {
    emit(errorEvent("internal", `sync-agents exec: could not write ${dir}/exec-audit.jsonl; refusing to run unaudited`));
    return 1;
  }
  let rc: number;
  try {
    rc = execve(program, req.argv, env);
  } catch (err) {
    emit(errorEvent("internal", `sync-agents exec: ${(err as Error).message}`));
    return 1;
  }
  emit(errorEvent("internal", `sync-agents exec: execve(${program}) failed (returned ${rc})`));
  return 1;
}

// ---------------------------------------------------------------- secret

type SecretArgs = { verb: string; key?: string; to?: string; dir?: string };

function parseSecretArgs(argv: string[]): SecretArgs {
  const [verb, ...rest] = argv;
  if (!verb) throw new VaultError("secret needs a verb: set, grant, revoke or list");
  if (!["set", "grant", "revoke", "list"].includes(verb)) throw new VaultError(`unknown secret verb: ${verb}`);
  const out: SecretArgs = { verb };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--to" || a === "--dir") {
      const v = rest[++i];
      if (!v) throw new VaultError(`${a} requires a value`);
      if (a === "--to") out.to = v;
      else out.dir = v;
    } else if (a.startsWith("--dir=")) out.dir = a.slice(6);
    else if (a.startsWith("-")) throw new VaultError(`unknown option: ${a}`);
    else if (out.key === undefined) out.key = a;
    else throw new VaultError(`unexpected argument: ${a}`);
  }
  if (verb !== "list" && out.key === undefined) throw new VaultError(`secret ${verb} needs a KEY`);
  if (out.key !== undefined && !VAULT_KEY.test(out.key)) throw new VaultError(`KEY must match ${VAULT_KEY.source}`);
  if (verb === "grant" && !out.to) throw new VaultError("secret grant needs --to SERVER");
  if ((verb === "set" || verb === "list") && (out.to || out.dir)) throw new VaultError(`secret ${verb} takes no --to or --dir`);
  if (verb === "revoke" && out.dir) throw new VaultError("secret revoke takes no --dir");
  return out;
}

export function runSecretCli(argv: string[], human: boolean, resolveHub: (dir: string | undefined) => string): number {
  const emit: Emit = (e) => writeEvents([e], human);
  if (argv.length === 0) {
    emit(errorEvent("usage", `sync-agents secret: a verb is required\n${SECRET_USAGE}`, { usage: SECRET_USAGE }));
    return 2;
  }
  let a: SecretArgs;
  try {
    a = parseSecretArgs(argv);
  } catch (err) {
    emit(errorEvent("usage", `sync-agents secret: ${(err as Error).message}\n${SECRET_USAGE}`, { usage: SECRET_USAGE }));
    return 2;
  }
  const dir = stateDir();
  try {
    switch (a.verb) {
      case "set": {
        let value = readFileSync(0, "utf8");
        value = value.replace(/\r?\n$/, "");
        keychainSet(a.key!, value);
        emit(summary(`sync-agents: stored "${a.key}" in the keychain.`, 1));
        return 0;
      }
      case "grant": {
        const hub = resolveHub(a.dir);
        const invocations: VaultInvocation[] = [];
        loadCanonicalServers(hub, undefined, undefined, { execPath: "/", invocations });
        const mine = invocations.filter((v) => v.server === a.to && v.key === a.key);
        if (mine.length === 0) {
          emit(errorEvent("config", `sync-agents secret grant: mcp/${a.to} does not use \${vault:${a.key}} in ${hub}`));
          return 1;
        }
        const { grants, added } = addGrants(
          loadGrants(dir),
          mine.map((v) => ({ key: v.key, env: v.env, argv: v.argv, server: v.server })),
        );
        if (added.length > 0) saveGrants(dir, grants);
        for (const g of added) emit(grantEvent("grant", g));
        emit(summary(added.length > 0 ? `sync-agents: granted "${a.key}" to mcp/${a.to}.` : `sync-agents: mcp/${a.to} already has its grants for "${a.key}".`, added.length));
        return 0;
      }
      case "revoke": {
        const grants = loadGrants(dir);
        const gone = grants.filter((g) => g.key === a.key && (!a.to || g.server === a.to));
        if (gone.length > 0) saveGrants(dir, grants.filter((g) => !gone.includes(g)));
        for (const g of gone) emit(grantEvent("revoke", g));
        emit(summary(`sync-agents: revoked ${gone.length} grant(s) for "${a.key}".`, gone.length));
        return 0;
      }
      default: {
        const grants = loadGrants(dir);
        for (const g of grants) emit(grantEvent("grant", g));
        emit(summary(`sync-agents: ${grants.length} grant(s).`, 0));
        return 0;
      }
    }
  } catch (err) {
    emit(errorEvent("config", `sync-agents secret ${a.verb}: ${(err as Error).message}`));
    return 1;
  }
}
