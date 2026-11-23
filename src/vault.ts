/**
 * Phase 5: vault-backed, grant-bound `sync-agents exec` (flyingrobots/agent-hub#10).
 *
 * A hub spec writes `${vault:KEY}` as the whole value of a stdio server's env entry. Sync
 * compiles that server to `<sync-agents> exec --keep <other env> --vault ENV=KEY -- <cmd> <args>`,
 * so no agent config holds the value or the reference. `exec` runs the command only when an
 * exact (key, env, argv) grant exists, reads the value from the macOS keychain, scrubs the
 * environment, and replaces itself with execve(2): the server keeps exec's PID, and no wrapper
 * process holds the secret.
 *
 * Threat model: same user. Anything running as the user can read the user's keychain items and
 * edit the grants file; the vault keeps secrets out of config files on disk, nothing more.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { McpServerSpec } from "./types.ts";

export const VAULT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAULT_OPEN = "${vault:";
const SERVICE = "agent-hub";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** KEY when the whole string is exactly `${vault:KEY}`, otherwise null. */
export function exactVaultRef(s: string): string | null {
  if (!s.startsWith(VAULT_OPEN) || !s.endsWith("}")) return null;
  const key = s.slice(VAULT_OPEN.length, -1);
  return VAULT_KEY.test(key) ? key : null;
}

export function containsVaultRef(s: string): boolean {
  return s.includes(VAULT_OPEN);
}

export type VaultUse = { env: string; key: string };

/** The vault entries of a spec's env, or [] when it has none. Throws on misuse. */
export function vaultUses(spec: McpServerSpec): VaultUse[] {
  const uses: VaultUse[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!containsVaultRef(v)) continue;
    const key = exactVaultRef(v);
    // Messages never quote the value: it may hold a secret next to the broken reference.
    if (key === null) {
      throw new VaultError(`env.${k}: a \${vault:KEY} reference must be the whole value, with KEY matching ${VAULT_KEY.source}`);
    }
    if (!ENV_NAME.test(k)) throw new VaultError(`env.${k}: not a valid environment variable name for a vault secret`);
    uses.push({ env: k, key });
  }
  return uses;
}

/**
 * The spec an agent runs: unchanged without vault references; otherwise the exec wrapper.
 * A vault reference anywhere but a stdio env value is refused, as is a command or argument
 * holding any reference, since a grant binds the exact argv the agent passes.
 */
export function compileVaultSpec(spec: McpServerSpec, execPath: string): McpServerSpec {
  const elsewhere: string[] = [];
  if (typeof spec.command === "string" && containsVaultRef(spec.command)) elsewhere.push("command");
  (spec.args ?? []).forEach((a, i) => containsVaultRef(a) && elsewhere.push(`args[${i}]`));
  if (typeof spec.url === "string" && containsVaultRef(spec.url)) elsewhere.push("url");
  for (const [h, v] of Object.entries(spec.headers ?? {})) if (containsVaultRef(v)) elsewhere.push(`headers.${h}`);
  // extra is passed to the agent as written, so a reference there would reach its config.
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (containsVaultRef(v)) elsewhere.push(path);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  if (spec.extra !== undefined) walk(spec.extra, "extra");
  if (elsewhere.length > 0) {
    throw new VaultError(`${elsewhere.join(", ")}: \${vault:KEY} is allowed only as the whole value of a stdio server's env entry`);
  }
  const uses = vaultUses(spec);
  if (uses.length === 0) return spec;
  if (typeof spec.command !== "string" || spec.command.length === 0) {
    throw new VaultError("${vault:KEY} needs a stdio server (a command): a remote server's agent connects directly");
  }
  if (!isAbsolute(spec.command)) {
    throw new VaultError("a server with ${vault:KEY} needs an absolute command path: a grant binds the program itself, which a PATH lookup could change");
  }
  const argv = [spec.command, ...(spec.args ?? [])];
  if (argv.some((a) => a.includes("${") || a.includes("{env:"))) {
    throw new VaultError("a server with ${vault:KEY} cannot use references in command or args: a grant binds the exact argv");
  }
  const vaultEnv = new Set(uses.map((u) => u.env));
  const rest = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([k]) => !vaultEnv.has(k)));
  const keep = Object.keys(rest).sort();
  const out: McpServerSpec = { ...spec, command: execPath, args: ["exec", ...keep.flatMap((k) => ["--keep", k]), ...uses.flatMap((u) => ["--vault", `${u.env}=${u.key}`]), "--", ...argv] };
  if (keep.length > 0) out.env = rest;
  else delete out.env;
  return out;
}

/** Where sync points agents for `exec`: AGENT_HUB_EXEC_PATH, else ~/.local/bin/sync-agents. */
export function defaultExecPath(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const p = env.AGENT_HUB_EXEC_PATH;
  if (p && isAbsolute(p)) return p;
  return join(homeDir, ".local", "bin", "sync-agents");
}

// ---------------------------------------------------------------- grants and audit

/**
 * A grant binds the key and variable to everything that decides what runs with the secret: the
 * exact argv, the real path of the program (argv[0] resolved through symlinks at grant time), and
 * the exact set of --keep variables passed through from the agent.
 */
export type Grant = { key: string; env: string; argv: string[]; program: string; keep: string[]; server?: string };

export function vaultStateDir(homeDir: string, xdgStateHome?: string): string {
  const base = xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(homeDir, ".local", "state");
  return join(base, "agent-hub");
}

export function loadGrants(stateDir: string): Grant[] {
  const p = join(stateDir, "grants.json");
  if (!existsSync(p)) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new VaultError(`${p}: not valid JSON; refusing every exec until it is fixed or removed`);
  }
  const d = doc as { version?: unknown; grants?: unknown };
  if (d?.version !== 1 || !Array.isArray(d.grants)) throw new VaultError(`${p}: expected {"version": 1, "grants": [...]}`);
  return d.grants.map((g, i) => {
    const x = g as Grant;
    if (
      typeof x?.key !== "string" || !VAULT_KEY.test(x.key) ||
      typeof x.env !== "string" || !ENV_NAME.test(x.env) ||
      !Array.isArray(x.argv) || x.argv.length === 0 || !x.argv.every((a) => typeof a === "string") ||
      typeof x.program !== "string" || !isAbsolute(x.program) ||
      !Array.isArray(x.keep) || !x.keep.every((k) => typeof k === "string" && ENV_NAME.test(k))
    ) {
      throw new VaultError(`${p}: grants[${i}] is not a {key, env, argv, program, keep} grant`);
    }
    return x;
  });
}

export function saveGrants(stateDir: string, grants: Grant[]): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const p = join(stateDir, "grants.json");
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

const sameArgv = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const sameSet = (a: readonly string[], b: readonly string[]) => sameArgv([...a].sort(), [...b].sort());

export function findGrant(
  grants: readonly Grant[],
  use: VaultUse,
  argv: readonly string[],
  program: string,
  keep: readonly string[],
): Grant | undefined {
  return grants.find(
    (g) => g.key === use.key && g.env === use.env && sameArgv(g.argv, argv) && g.program === program && sameSet(g.keep, keep),
  );
}

/** The real path of a program, or null when it does not exist. */
export function realProgram(cmd: string): string | null {
  if (!isAbsolute(cmd)) return null;
  try {
    return realpathSync(cmd);
  } catch {
    return null;
  }
}

export function addGrants(existing: Grant[], add: Grant[]): { grants: Grant[]; added: Grant[] } {
  const grants = [...existing];
  const added: Grant[] = [];
  for (const g of add) {
    if (findGrant(grants, g, g.argv, g.program, g.keep)) continue;
    grants.push(g);
    added.push(g);
  }
  return { grants, added };
}

/** One value-free audit line per exec decision. */
export function appendAudit(stateDir: string, line: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const p = join(stateDir, "exec-audit.jsonl");
  appendFileSync(p, `${JSON.stringify({ _schema: { id: "agent_hub.exec_audit", version: "1.0.0" }, kind: "exec_audit", ts: new Date().toISOString(), ...line })}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}

// ---------------------------------------------------------------- keychain

/** `/usr/bin/security` on macOS; AGENT_HUB_SECURITY_BIN selects another (tests use a fake). */
function securityBin(env: NodeJS.ProcessEnv): string {
  const override = env.AGENT_HUB_SECURITY_BIN;
  if (override) {
    if (!isAbsolute(override)) throw new VaultError("AGENT_HUB_SECURITY_BIN must be an absolute path");
    return override;
  }
  if (process.platform !== "darwin") {
    throw new VaultError(`the vault uses the macOS keychain, which ${process.platform} does not have`);
  }
  return "/usr/bin/security";
}

/** Store a value. It goes to `security -i` on stdin, hex-encoded, never in an argv. */
export function keychainSet(key: string, value: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!VAULT_KEY.test(key)) throw new VaultError(`key must match ${VAULT_KEY.source}`);
  if (value.length === 0) throw new VaultError("refusing to store an empty value");
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw new VaultError("the value must be printable ASCII (the keychain prints anything else as hex)");
  }
  const hex = Buffer.from(value, "utf8").toString("hex");
  const bin = securityBin(env);
  const r = spawnSync(bin, ["-i"], {
    input: `add-generic-password -U -s ${SERVICE} -a ${key} -X ${hex}\n`,
    stdio: ["pipe", "ignore", "pipe"],
    env,
  });
  if (r.error) throw new VaultError(`could not run ${bin}: ${r.error.message}`);
  // `security -i` exits 0 even when a command fails, so confirm the item exists.
  const check = spawnSync(bin, ["find-generic-password", "-s", SERVICE, "-a", key], { stdio: ["ignore", "ignore", "ignore"], env });
  if (check.status !== 0) throw new VaultError(`the keychain did not store "${key}" (${bin} exited ${r.status})`);
}

/** Read a value into memory. Nothing is written or printed. */
export function keychainGet(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const bin = securityBin(env);
  const r = spawnSync(bin, ["find-generic-password", "-s", SERVICE, "-a", key, "-w"], { stdio: ["ignore", "pipe", "ignore"], env, encoding: "utf8" });
  if (r.error) throw new VaultError(`could not run ${bin}: ${r.error.message}`);
  if (r.status !== 0) throw new VaultError(`no keychain item for "${key}" (store one with: sync-agents secret set ${key})`);
  const value = (r.stdout as string).replace(/\n$/, "");
  if (value.length === 0) throw new VaultError(`the keychain item for "${key}" is empty`);
  return value;
}

// ---------------------------------------------------------------- exec

/** Variables exec passes through besides --keep names and the secrets themselves. */
export const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];

export type ExecRequest = { keep: string[]; vault: VaultUse[]; argv: string[] };

export function parseExecArgs(args: readonly string[]): ExecRequest {
  const keep: string[] = [];
  const vault: VaultUse[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a === "--keep" || a === "--vault") {
      const v = args[++i];
      if (v === undefined) throw new VaultError(`${a} requires a value`);
      if (a === "--keep") {
        if (!ENV_NAME.test(v)) throw new VaultError("--keep takes an environment variable name");
        keep.push(v);
      } else {
        const eq = v.indexOf("=");
        const use = { env: v.slice(0, eq), key: v.slice(eq + 1) };
        if (eq < 1 || !ENV_NAME.test(use.env) || !VAULT_KEY.test(use.key)) throw new VaultError("--vault takes ENV=KEY");
        vault.push(use);
      }
      continue;
    }
    throw new VaultError(`unknown exec option (expected --keep NAME, --vault ENV=KEY, then -- COMMAND ARGS)`);
  }
  if (i >= args.length) throw new VaultError("exec needs -- followed by the command to run");
  const argv = args.slice(i + 1);
  if (argv.length === 0) throw new VaultError("exec needs a command after --");
  if (vault.length === 0) throw new VaultError("exec needs at least one --vault ENV=KEY (run the command directly otherwise)");
  return { keep, vault, argv };
}

/** Replace this process. Returns only on failure. */
export function execve(path: string, argv: readonly string[], envp: Record<string, string>): number {
  // Loaded lazily: only exec needs FFI.
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const libc = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const lib = dlopen(libc, { execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
  const keepAlive: Buffer[] = [];
  const cstr = (s: string) => {
    if (s.includes("\0")) throw new VaultError("an argument or variable contains a NUL byte");
    const b = Buffer.from(`${s}\0`, "utf8");
    keepAlive.push(b);
    return b;
  };
  const array = (xs: readonly string[]) => {
    const a = new BigUint64Array(xs.length + 1);
    xs.forEach((x, i) => (a[i] = BigInt(ptr(cstr(x)))));
    return a;
  };
  const argvArr = array(argv);
  const envArr = array(Object.entries(envp).map(([k, v]) => `${k}=${v}`));
  const rc = lib.symbols.execve(ptr(cstr(path)), ptr(argvArr), ptr(envArr));
  void keepAlive;
  return rc;
}

/** Serialize read-modify-write of grants.json (flock; waits up to ~3 s for another writer). */
export function withGrantsLock<T>(stateDir: string, fn: () => T): T {
  const { acquireApplyLock, releaseApplyLock } = require("./lock.ts") as typeof import("./lock.ts");
  let handle;
  for (let i = 0; ; i++) {
    try {
      handle = acquireApplyLock(join(stateDir, "grants.lock"), stateDir);
      break;
    } catch (err) {
      if (i >= 60) throw new VaultError(`grants.json is locked by another sync-agents secret run (${(err as Error).message})`);
      Bun.sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    releaseApplyLock(handle);
  }
}
