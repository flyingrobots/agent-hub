import { describe, expect, test } from "bun:test";
import {
  aggregateServers,
  compileWithExtra,
  decompileEntry,
  rewritePlaintextSecrets,
  roundTripDiff,
} from "../src/import.ts";
import type { AgentId } from "../src/types.ts";

const AGENTS: AgentId[] = ["antigravity", "claude", "codex", "cursor", "opencode"];

// Native entries each agent writes for itself, per its documented shape.
function nativeGenerator(seed: number) {
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x100000000;
  };
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const word = () => pick(["alpha", "beta", "x-y", "srv_1", "/usr/bin/tool", "--flag", "v=1", "naïve"]);
  const envName = () => pick(["MODE", "LOG_LEVEL", "REGION", "HOME_DIR"]);
  const record = (keyGen: () => string, valGen: () => string) => {
    const out: Record<string, string> = {};
    const n = Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) out[keyGen()] = valGen();
    return out;
  };
  const args = () => Array.from({ length: Math.floor(rnd() * 3) }, word);
  const url = () => pick(["https://e.invalid/mcp", "https://e.invalid/sse", "http://127.0.0.1:9/x"]);
  const header = () => pick(["X-Client", "Accept", "X-Region"]);
  return (agent: AgentId): Record<string, unknown> => {
    const remote = rnd() < 0.4;
    const env = record(envName, word);
    const headers = record(header, word);
    switch (agent) {
      case "claude":
        return remote
          ? { type: pick(["http", "sse"]), url: url(), ...(Object.keys(headers).length ? { headers } : {}) }
          : { type: "stdio", command: word(), args: args(), ...(Object.keys(env).length ? { env } : {}) };
      case "cursor":
        if (remote) return { url: url(), ...(Object.keys(headers).length ? { headers } : {}) };
        return { type: "stdio", command: word(), ...(rnd() < 0.5 ? { args: ["a"] } : {}), ...(Object.keys(env).length ? { env } : {}) };
      case "codex":
        if (remote) {
          return {
            url: url(),
            ...(Object.keys(headers).length ? { http_headers: headers } : {}),
            ...(rnd() < 0.3 ? { bearer_token_env_var: "API_TOKEN" } : {}),
            ...(rnd() < 0.3 ? { startup_timeout_sec: 20 } : {}),
          };
        }
        return {
          command: word(),
          ...(rnd() < 0.5 ? { args: ["a", "b"] } : {}),
          ...(Object.keys(env).length ? { env } : {}),
          ...(rnd() < 0.3 ? { env_vars: ["GITHUB_TOKEN"] } : {}),
          ...(rnd() < 0.3 ? { tool_timeout_sec: 60 } : {}),
        };
      case "opencode":
        if (remote) return { type: "remote", url: url(), ...(Object.keys(headers).length ? { headers } : {}), ...(rnd() < 0.3 ? { timeout: 5000 } : {}) };
        return {
          type: "local",
          command: [word(), ...args()],
          ...(Object.keys(env).length ? { environment: env } : {}),
          ...(rnd() < 0.3 ? { disabled: true } : {}),
        };
      case "antigravity":
        if (remote) return { serverUrl: url(), ...(Object.keys(headers).length ? { headers } : {}), disabled: false };
        return { command: word(), ...(rnd() < 0.5 ? { args: ["a"] } : {}), ...(Object.keys(env).length ? { env } : {}), disabled: false };
    }
  };
}

describe("import: decompile and the round-trip gate (flyingrobots/agent-hub#7)", () => {
  test("property: every generated native entry decompiles and compiles back to an equal entry, for all five adapters", () => {
    const gen = nativeGenerator(11);
    let n = 0;
    for (let i = 0; i < 400; i++) {
      for (const agent of AGENTS) {
        const raw = gen(agent);
        const d = decompileEntry(agent, raw);
        expect(roundTripDiff(agent, raw, d)).toEqual([]);
        n++;
      }
    }
    expect(n).toBe(2000);
  });

  test("native references come back as ${env:NAME}", () => {
    expect(decompileEntry("claude", { type: "stdio", command: "x", args: ["${TOKEN}"] }).spec.args).toEqual(["${env:TOKEN}"]);
    expect(decompileEntry("opencode", { type: "remote", url: "https://h/{env:P}" }).spec.url).toBe("https://h/${env:P}");
    expect(decompileEntry("codex", { url: "https://h", bearer_token_env_var: "API_TOKEN" }).spec.headers).toEqual({
      Authorization: "Bearer ${env:API_TOKEN}",
    });
    expect(decompileEntry("codex", { command: "x", env_vars: ["GH"] }).spec.env).toEqual({ GH: "${env:GH}" });
  });

  test("a lossy entry is refused with an exact field diff, for every adapter", () => {
    // Each of these has a field the canonical form cannot carry back faithfully.
    const lossy: Array<[AgentId, Record<string, unknown>]> = [
      ["antigravity", { command: "x", disabled: true }],
      ["claude", { type: "stdio", command: "x", args: [] , env: { A: "${VAR:-d}" } }],
      ["codex", { command: "x", env: { A: "${env:A}" } }],
      ["cursor", { type: "stdio", command: "x", env: { A: "{env:A}" } }],
      ["opencode", { type: "local", command: ["x", "${env:A}"] }],
    ];
    for (const [agent, raw] of lossy) {
      let diff: string[];
      try {
        diff = roundTripDiff(agent, raw, decompileEntry(agent, raw));
      } catch (err) {
        expect(String(err)).toMatch(/import|reference|env/);
        continue;
      }
      expect(diff.length).toBeGreaterThan(0);
      for (const d of diff) expect(d).toMatch(/^[a-z_.[\]0-9A-Z-]+: /);
    }
  });

  test("extra passes native fields through, and is refused when it names a field agent-hub manages", () => {
    expect(compileWithExtra("codex", "stdio", { command: "x" }, { startup_timeout_sec: 20 })).toEqual({ command: "x", startup_timeout_sec: 20 });
    expect(() => compileWithExtra("claude", "stdio", { command: "x" }, { command: "y" })).toThrow(/extra.*command/);
    expect(() => compileWithExtra("codex", "http", { url: "https://h" }, { bearer_token_env_var: "X" })).toThrow(/extra/);
  });
});

describe("import: aggregation (flyingrobots/agent-hub#7)", () => {
  test("identical specs become the base; a differing agent gets an override; installed agents without the server are disabled", () => {
    const docs = aggregateServers(
      new Map<AgentId, Map<string, Record<string, unknown>>>([
        ["claude", new Map([["gh", { type: "stdio", command: "/bin/gh", args: [], env: { MODE: "a" } }]])],
        ["cursor", new Map([["gh", { type: "stdio", command: "/bin/gh", env: { MODE: "a" } }]])],
        ["codex", new Map([["gh", { command: "/bin/gh", env: { MODE: "b" } }]])],
      ]),
      new Set<AgentId>(["claude", "cursor", "codex", "opencode"]),
    );
    expect(docs.refused).toEqual([]);
    expect(docs.servers.get("gh")).toEqual({
      mcp: { command: "/bin/gh", env: { MODE: "a" } },
      overrides: { codex: { env: { MODE: "b" } }, opencode: { disabled: true } },
    });
  });

  test("aggregation is deterministic: the same input gives the same bytes in any insertion order", () => {
    const a = new Map<AgentId, Map<string, Record<string, unknown>>>([
      ["cursor", new Map([["s", { url: "https://h" }], ["t", { type: "stdio", command: "t" }]])],
      ["claude", new Map([["s", { type: "http", url: "https://h" }]])],
    ]);
    const b = new Map<AgentId, Map<string, Record<string, unknown>>>([
      ["claude", new Map([["s", { type: "http", url: "https://h" }]])],
      ["cursor", new Map([["t", { type: "stdio", command: "t" }], ["s", { url: "https://h" }]])],
    ]);
    const installed = new Set<AgentId>(["claude", "cursor"]);
    const ja = JSON.stringify([...aggregateServers(a, installed).servers]);
    const jb = JSON.stringify([...aggregateServers(b, installed).servers]);
    expect(ja).toBe(jb);
  });

  test("a server one agent holds losslessly and another lossily is refused as a whole, naming the field", () => {
    const docs = aggregateServers(
      new Map<AgentId, Map<string, Record<string, unknown>>>([
        ["claude", new Map([["s", { type: "stdio", command: "x", args: [] }]])],
        ["antigravity", new Map([["s", { command: "x", disabled: true }]])],
      ]),
      new Set<AgentId>(["claude", "antigravity"]),
    );
    expect(docs.servers.has("s")).toBe(false);
    expect(docs.refused.map((r) => r.server)).toEqual(["s"]);
    expect(docs.refused[0]!.reason).toContain("disabled");
  });
});

describe("import: plaintext secrets (flyingrobots/agent-hub#7)", () => {
  test("rewriting replaces each flagged literal with a reference and reports only variable names", () => {
    const secret = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    const { doc, rewritten } = rewritePlaintextSecrets("gh", {
      mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: secret, MODE: "a" } },
      overrides: { codex: { headers: { Authorization: "Bearer abc123" } } },
    });
    expect(doc.mcp).toEqual({ command: "/bin/gh", env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", MODE: "a" } });
    expect((doc.overrides as Record<string, { headers: Record<string, string> }>)["codex"]!.headers.Authorization).toBe("Bearer ${env:GH_TOKEN}");
    expect(rewritten.map((r) => r.variable).sort()).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
    expect(JSON.stringify(rewritten)).not.toContain(secret);
    expect(JSON.stringify(rewritten)).not.toContain("abc123");
  });
});

describe("overrides.<agent>.extra in the hub (flyingrobots/agent-hub#7)", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  function hub(doc: unknown) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-extra-")));
    const h = path.join(home, ".agents");
    fs.mkdirSync(path.join(h, "mcp", "s"), { recursive: true });
    fs.mkdirSync(path.join(h, "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(h, "mcp", "s", "mcp.json"), JSON.stringify(doc));
    return { home, opts: { hubDir: h, homeDir: home, xdgConfigHome: path.join(home, ".config"), xdgStateHome: path.join(home, ".local", "state") } };
  }
  const { runSync } = require("./jsonl.ts") as typeof import("./jsonl.ts");
  const { parseTargetSelector } = require("../src/types.ts") as typeof import("../src/types.ts");
  const targets = (...t: string[]) => t.map((x) => parseTargetSelector(x)!);

  test("Codex extra fields land in config.toml (scalars, arrays, tables) and --check is then clean", () => {
    const { home, opts } = hub({
      mcp: { command: "/bin/s" },
      overrides: { codex: { extra: { startup_timeout_sec: 20, enabled_tools: ["a", "b"], tool_options: { verbose: true } } } },
    });
    expect(runSync({ ...opts, targets: targets("codex:mcp") }).exitCode).toBe(0);
    const toml = Bun.TOML.parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    expect(toml.mcp_servers.s).toEqual({ command: "/bin/s", startup_timeout_sec: 20, enabled_tools: ["a", "b"], tool_options: { verbose: true } });
    expect(runSync({ ...opts, targets: targets("codex:mcp"), checkOnly: true }).exitCode).toBe(0);
  });

  test("JSON targets get extra as written; extra on the base mcp, or naming a managed field, is refused", () => {
    const { home, opts } = hub({ mcp: { command: "/bin/s" }, overrides: { claude: { extra: { timeout: 30 } } } });
    expect(runSync({ ...opts, targets: targets("claude:mcp") }).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.s).toEqual({ type: "stdio", command: "/bin/s", args: [], timeout: 30 });
    const base = hub({ mcp: { command: "/bin/s", extra: { timeout: 1 } } });
    const rb = runSync({ ...base.opts, targets: targets("claude:mcp") });
    expect(rb.exitCode).toBe(1);
    expect(rb.stderr.join("\n")).toContain("overrides.<agent>");
    const managed = hub({ mcp: { command: "/bin/s" }, overrides: { claude: { extra: { command: "/bin/other" } } } });
    const rm = runSync({ ...managed.opts, targets: targets("claude:mcp") });
    expect(rm.exitCode).toBe(1);
    expect(rm.stderr.join("\n")).toContain("extra.command");
  });

  test("extra values are scanned by the plaintext detector", () => {
    const { opts } = hub({ mcp: { command: "/bin/s" }, overrides: { claude: { extra: { api_token: "ghp_0123456789abcdefghijABCDEFGHIJ012345" } } } });
    const r = runSync({ ...opts, targets: targets("claude:mcp") });
    expect(r.events.filter((e) => e.id === "agent_hub.warning").map((w) => w.data.field)).toEqual(["extra.api_token"]);
  });
});
