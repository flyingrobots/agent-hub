import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "./jsonl.ts";
import { sha256Hex, stableJson } from "../src/paths.ts";
import { getStatePaths, loadOwnershipState } from "../src/state.ts";
import { parseTargetSelector, type SyncOptions } from "../src/types.ts";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

// Allowed keys of OpenCode's current server objects, from https://opencode.ai/config.json
// ($defs Mcp.LocalConfigEncoded / Mcp.RemoteConfigEncoded, both additionalProperties: false).
const LOCAL_KEYS = ["type", "command", "cwd", "environment", "disabled", "codemode", "timeout", "protocol", "pool"];
const REMOTE_KEYS = ["type", "url", "headers", "oauth", "disabled", "codemode", "timeout", "protocol", "pool"];
function assertV2Shape(entry: Record<string, unknown>) {
  if (entry.type === "local") {
    expect(Array.isArray(entry.command)).toBe(true);
    for (const k of Object.keys(entry)) expect(LOCAL_KEYS).toContain(k);
  } else {
    expect(entry.type).toBe("remote");
    expect(typeof entry.url).toBe("string");
    for (const k of Object.keys(entry)) expect(REMOTE_KEYS).toContain(k);
  }
}

// The comparable form agent-hub used for OpenCode entries before this change (legacy layout).
function legacyDigest(entry: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...entry };
  if (copy.enabled === undefined) copy.enabled = true;
  return sha256Hex(stableJson(copy));
}

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-ocv2-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "mcp"), { recursive: true });
  mkdirSync(join(hub, "skills"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode", "skills"), { recursive: true });
  const cfg = join(home, ".config", "opencode", "opencode.json");
  const base: SyncOptions = {
    hubDir: hub,
    homeDir: home,
    xdgConfigHome: join(home, ".config"),
    xdgStateHome: join(home, ".local", "state"),
    targets: [parseTargetSelector("opencode")!],
  };
  return { home, hub, cfg, base };
}
function server(hub: string, name: string, spec: Record<string, unknown>) {
  mkdirSync(join(hub, "mcp", name), { recursive: true });
  writeFileSync(join(hub, "mcp", name, "mcp.json"), JSON.stringify({ mcp: spec }));
}
const out = (r: { stdout: string[]; stderr: string[] }) => [...r.stdout, ...r.stderr].join("\n");

// A ledger as the previous version left it: each named entry recorded against cfg with its legacy digest.
function seedLedger(home: string, hub: string, cfg: string, xdgStateHome: string, entries: Record<string, Record<string, unknown>>) {
  const { statePath } = getStatePaths(hub, home, xdgStateHome);
  mkdirSync(join(home, ".local", "state", "agent-hub"), { recursive: true });
  const empty = { claude: {}, codex: {}, antigravity: {}, cursor: {}, opencode: {} };
  const opencode: Record<string, unknown> = {};
  for (const [name, e] of Object.entries(entries)) {
    opencode[name] = { configPath: cfg, digest: legacyDigest(e), basis: "created", updatedAt: "2026-11-01T00:00:00Z" };
  }
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      hubPath: hub,
      generation: 1,
      links: {},
      mcp: { ...empty, opencode },
      resolvedLegacyV1: { claude: [], codex: [], antigravity: [], cursor: [], opencode: [] },
    }),
  );
  return statePath;
}
function writeCfg(cfg: string, doc: unknown): string {
  const text = JSON.stringify(doc, null, 2) + "\n";
  writeFileSync(cfg, text);
  chmodSync(cfg, 0o600);
  return text;
}

describe("OpenCode adapter writes the current mcp.servers layout (flyingrobots/agent-hub#13)", () => {
  test("fresh config: servers go under mcp.servers in OpenCode's current shape; --check is clean", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "local-srv", { command: "/bin/x", args: ["--a"], env: { K: "v" } });
    server(hub, "remote-srv", { transport: "http", url: "https://e.invalid/mcp", headers: { H: "1" } });
    expect(runSync(base).exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(cfg, "utf8"));
    expect(doc.mcp.servers["local-srv"]).toEqual({ type: "local", command: ["/bin/x", "--a"], environment: { K: "v" } });
    expect(doc.mcp.servers["remote-srv"]).toEqual({ type: "remote", url: "https://e.invalid/mcp", headers: { H: "1" } });
    for (const e of Object.values(doc.mcp.servers)) assertV2Shape(e as Record<string, unknown>);
    expect(Object.keys(doc.mcp)).toEqual(["servers"]);
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });

  test("user content is kept: other top-level keys, mcp.timeout, and the user's own mcp.servers and legacy entries", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const mine = {
      $schema: "https://opencode.ai/config.json",
      theme: "x",
      mcp: {
        timeout: { startup: 5000 },
        servers: { "my-v2": { type: "remote", url: "https://mine.invalid" } },
        "my-legacy": { type: "local", command: ["/bin/mine"], enabled: true },
      },
    };
    writeFileSync(cfg, JSON.stringify(mine, null, 2) + "\n");
    chmodSync(cfg, 0o600);
    expect(runSync(base).exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(cfg, "utf8"));
    expect(doc.$schema).toBe(mine.$schema);
    expect(doc.theme).toBe("x");
    expect(doc.mcp.timeout).toEqual({ startup: 5000 });
    expect(doc.mcp["my-legacy"]).toEqual(mine.mcp["my-legacy"]);
    expect(doc.mcp.servers["my-v2"]).toEqual(mine.mcp.servers["my-v2"]);
    expect(doc.mcp.servers.alpha).toEqual({ type: "local", command: ["/bin/alpha"] });
  });

  test("migration: a legacy mcp.<name> entry agent-hub wrote moves to mcp.servers; --check is then clean", () => {
    const { home, hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const legacy = { type: "local", command: ["/bin/alpha"], enabled: true };
    writeFileSync(cfg, JSON.stringify({ theme: "x", mcp: { alpha: legacy } }, null, 2) + "\n");
    chmodSync(cfg, 0o600);
    // A ledger as the previous version left it: alpha recorded against this file, legacy digest.
    const { statePath } = getStatePaths(hub, home, base.xdgStateHome);
    mkdirSync(join(home, ".local", "state", "agent-hub"), { recursive: true });
    const empty = { claude: {}, codex: {}, antigravity: {}, cursor: {}, opencode: {} };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        hubPath: hub,
        generation: 1,
        links: {},
        mcp: { ...empty, opencode: { alpha: { configPath: cfg, digest: legacyDigest(legacy), basis: "created", updatedAt: "2026-11-01T00:00:00Z" } } },
        resolvedLegacyV1: { claude: [], codex: [], antigravity: [], cursor: [], opencode: [] },
      }),
    );
    const r = runSync(base);
    expect(out(r)).not.toContain("conflict");
    // The move itself writes the current shape; no follow-up update is needed to drop `enabled`.
    expect(out(r)).toContain("mcp-migrate-layout");
    expect(out(r)).not.toContain("mcp-update");
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(cfg, "utf8"));
    expect(doc.mcp.alpha).toBeUndefined();
    expect(doc.mcp.servers.alpha).toEqual({ type: "local", command: ["/bin/alpha"] });
    expect(doc.theme).toBe("x");
    expect(loadOwnershipState(statePath, hub).state.mcp.opencode.alpha).toBeDefined();
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });

  test("an unmanaged legacy entry with a hub server's name is a conflict; the file is unchanged", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const text = JSON.stringify({ mcp: { alpha: { type: "local", command: ["/bin/mine"], enabled: true } } }, null, 2) + "\n";
    writeFileSync(cfg, text);
    const r = runSync(base);
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain("conflict");
    expect(readFileSync(cfg, "utf8")).toBe(text);
  });

  function reservedNameIsRefused(reserved: string) {
      const { hub, cfg, base } = sandbox();
      server(hub, reserved, { command: "/bin/t" });
      const r = runSync(base);
      expect(r.exitCode).toBe(1);
      expect(out(r)).toContain("reserved");
      const claudeOnly = runSync({ ...base, targets: [parseTargetSelector("claude")!] });
      expect(claudeOnly.exitCode).toBe(0);
      expect(() => readFileSync(cfg, "utf8")).toThrow();
  }
  test("hub server name servers collides with OpenCode's own mcp keys and is refused for OpenCode only", () =>
    reservedNameIsRefused("servers"));
  test("hub server name timeout collides with OpenCode's own mcp keys and is refused for OpenCode only", () =>
    reservedNameIsRefused("timeout"));

  test("a non-object mcp.servers is refused without clobbering", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const text = JSON.stringify({ mcp: { servers: [] } }) + "\n";
    writeFileSync(cfg, text);
    const r = runSync(base);
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain("mcp.servers");
    expect(readFileSync(cfg, "utf8")).toBe(text);
  });

  test("a user's own old-layout server named servers is not mistaken for the server map; the run is refused and the file unchanged", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const text = writeCfg(cfg, { mcp: { servers: { type: "local", command: ["/bin/mine"], enabled: true } } });
    const r = runSync(base);
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain("not server objects");
    expect(readFileSync(cfg, "utf8")).toBe(text);
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(1);
  });

  test("an old-layout server named servers that agent-hub wrote is removed once the hub no longer has it; nothing is written inside it", () => {
    const { home, hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const oldServers = { type: "local", command: ["/bin/s"], enabled: true };
    const oldAlpha = { type: "local", command: ["/bin/alpha"], enabled: true };
    writeCfg(cfg, { theme: "x", mcp: { servers: oldServers, alpha: oldAlpha } });
    const statePath = seedLedger(home, hub, cfg, base.xdgStateHome!, { servers: oldServers, alpha: oldAlpha });
    const r = runSync(base);
    expect(r.exitCode).toBe(0);
    expect(out(r)).not.toContain("already absent");
    const doc = JSON.parse(readFileSync(cfg, "utf8"));
    expect(doc.mcp).toEqual({ servers: { alpha: { type: "local", command: ["/bin/alpha"] } } });
    expect(doc.theme).toBe("x");
    const recs = loadOwnershipState(statePath, hub).state.mcp.opencode;
    expect(Object.keys(recs)).toEqual(["alpha"]);
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });

  test("an old-layout server named timeout that agent-hub wrote is removed when disabled for OpenCode, not reported absent", () => {
    const { home, hub, cfg, base } = sandbox();
    mkdirSync(join(hub, "mcp", "timeout"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "timeout", "mcp.json"),
      JSON.stringify({ mcp: { command: "/bin/t" }, overrides: { opencode: { disabled: true } } }),
    );
    const oldTimeout = { type: "local", command: ["/bin/t"], enabled: true };
    writeCfg(cfg, { mcp: { timeout: oldTimeout } });
    const statePath = seedLedger(home, hub, cfg, base.xdgStateHome!, { timeout: oldTimeout });
    const r = runSync(base);
    expect(r.exitCode).toBe(0);
    expect(out(r)).not.toContain("already absent");
    const doc = JSON.parse(readFileSync(cfg, "utf8"));
    expect(doc.mcp.timeout).toBeUndefined();
    expect(loadOwnershipState(statePath, hub).state.mcp.opencode.timeout).toBeUndefined();
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });

  test("a user's real mcp.timeout settings are kept when an old timeout record is retired", () => {
    const { home, hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    writeCfg(cfg, { mcp: { timeout: { startup: 5000 } } });
    const statePath = seedLedger(home, hub, cfg, base.xdgStateHome!, { timeout: { type: "local", command: ["/bin/t"], enabled: true } });
    const r = runSync(base);
    expect(r.exitCode).toBe(0);
    expect(out(r)).not.toContain("already absent");
    expect(JSON.parse(readFileSync(cfg, "utf8")).mcp.timeout).toEqual({ startup: 5000 });
    expect(loadOwnershipState(statePath, hub).state.mcp.opencode.timeout).toBeUndefined();
  });

  test("an edited agent-hub legacy entry is a conflict and is not moved, even with --force", () => {
    const { home, hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const written = { type: "local", command: ["/bin/alpha"], enabled: true };
    const text = writeCfg(cfg, { mcp: { alpha: { ...written, command: ["/bin/alpha", "--mine"] } } });
    seedLedger(home, hub, cfg, base.xdgStateHome!, { alpha: written });
    for (const force of [false, true]) {
      const r = runSync({ ...base, force });
      expect(r.exitCode).toBe(1);
      expect(out(r)).toContain("conflict");
      expect(readFileSync(cfg, "utf8")).toBe(text);
    }
  });

  test("an agent-hub legacy entry with a same-named user entry in mcp.servers is a conflict; the user's entry survives --force", () => {
    const { home, hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const written = { type: "local", command: ["/bin/alpha"], enabled: true };
    const text = writeCfg(cfg, { mcp: { servers: { alpha: { type: "local", command: ["/bin/user-alpha"] } }, alpha: written } });
    seedLedger(home, hub, cfg, base.xdgStateHome!, { alpha: written });
    for (const force of [false, true]) {
      const r = runSync({ ...base, force });
      expect(r.exitCode).toBe(1);
      expect(readFileSync(cfg, "utf8")).toBe(text);
    }
  });

  test("a user key named __proto__ under mcp survives a migration render", () => {
    const { home, hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    const legacy = { type: "local", command: ["/bin/alpha"], enabled: true };
    writeFileSync(cfg, `{"mcp":{"__proto__":{"type":"local","command":["/bin/p"]},"alpha":${JSON.stringify(legacy)}}}\n`);
    chmodSync(cfg, 0o600);
    seedLedger(home, hub, cfg, base.xdgStateHome!, { alpha: legacy });
    expect(runSync(base).exitCode).toBe(0);
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain('"__proto__"');
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(text).mcp, "__proto__")).toBe(true);
  });

  test("an unmanaged old-layout entry is left in place and reported by --explain", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    writeCfg(cfg, { mcp: { "my-legacy": { type: "local", command: ["/bin/mine"], enabled: true } } });
    const r = runSync({ ...base, explain: true });
    expect(r.exitCode).toBe(0);
    expect(out(r)).toContain("my-legacy");
    expect(out(r)).toContain("deprecated");
  });

  test("an enabled key added to a managed mcp.servers entry is drift, not in sync", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha" });
    expect(runSync(base).exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(cfg, "utf8"));
    doc.mcp.servers.alpha.enabled = true;
    writeFileSync(cfg, JSON.stringify(doc, null, 2) + "\n");
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(1);
  });

  test("migration and a hub spec change in the same run: moved, then updated; --check is clean", () => {
    const { home, hub, cfg, base } = sandbox();
    server(hub, "alpha", { command: "/bin/alpha-v2" });
    const legacy = { type: "local", command: ["/bin/alpha"], enabled: true };
    writeCfg(cfg, { mcp: { alpha: legacy } });
    seedLedger(home, hub, cfg, base.xdgStateHome!, { alpha: legacy });
    const r = runSync(base);
    expect(out(r)).not.toContain("conflict");
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(cfg, "utf8"));
    expect(doc.mcp).toEqual({ servers: { alpha: { type: "local", command: ["/bin/alpha-v2"] } } });
    expect(runSync({ ...base, checkOnly: true }).exitCode).toBe(0);
  });
});
