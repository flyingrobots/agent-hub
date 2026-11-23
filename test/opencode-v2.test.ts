import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/cli.ts";
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

  test("hub server names that collide with OpenCode's own mcp keys (servers, timeout) are refused for OpenCode only", () => {
    const { hub, cfg, base } = sandbox();
    server(hub, "timeout", { command: "/bin/t" });
    const r = runSync(base);
    expect(r.exitCode).toBe(1);
    expect(out(r)).toContain("reserved");
    const claudeOnly = runSync({ ...base, targets: [parseTargetSelector("claude")!] });
    expect(claudeOnly.exitCode).toBe(0);
    expect(() => readFileSync(cfg, "utf8")).toThrow();
  });

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
});
