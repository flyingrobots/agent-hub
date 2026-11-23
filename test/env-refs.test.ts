import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseTargetSelector } from "../src/types.ts";
import { runSync } from "./jsonl.ts";
import { MCP_ADAPTER_BY_ID } from "../src/adapters.ts";
import { detectPlaintextSecrets, exactEnvRef, hasEnvRef, parseEnvRefs, rewriteEnvRefs } from "../src/env-refs.ts";
import { renderCodexSection, rewriteCodexToml } from "../src/toml-edit.ts";
import type { AgentId, McpServerSpec, McpTransport } from "../src/types.ts";

const compile = (agent: AgentId, transport: McpTransport, spec: McpServerSpec) =>
  MCP_ADAPTER_BY_ID[agent].compile(transport, spec, "srv", "mcp/srv/mcp.json");

describe("${env:VAR} parsing (flyingrobots/agent-hub#6)", () => {
  test("parses exact, partial and repeated references; leaves other text alone", () => {
    expect(parseEnvRefs("${env:API_TOKEN}")).toEqual([{ kind: "ref", name: "API_TOKEN" }]);
    expect(parseEnvRefs("Bearer ${env:X}-suffix")).toEqual([
      { kind: "literal", text: "Bearer " },
      { kind: "ref", name: "X" },
      { kind: "literal", text: "-suffix" },
    ]);
    expect(parseEnvRefs("${env:A}${env:_B9}")).toEqual([{ kind: "ref", name: "A" }, { kind: "ref", name: "_B9" }]);
    expect(parseEnvRefs("plain $HOME ${HOME} {env:X}")).toEqual([{ kind: "literal", text: "plain $HOME ${HOME} {env:X}" }]);
    expect(exactEnvRef("${env:X}")).toBe("X");
    expect(exactEnvRef(" ${env:X}")).toBeNull();
    expect(hasEnvRef("a${env:X}")).toBe(true);
    expect(hasEnvRef("a${X}")).toBe(false);
  });

  test("rejects invalid variable names and unterminated references", () => {
    for (const bad of ["${env:}", "${env:lower}", "${env:9X}", "${env:A-B}", "${env:A B}", "${env:X", "x ${env:"]) {
      expect(() => parseEnvRefs(bad)).toThrow(/env/);
    }
  });

  test("property: random strings never crash the parser, and text without ${env: never yields a reference", () => {
    let seed = 42;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x100000000;
    };
    const alphabet = ["$", "{", "}", "e", "n", "v", ":", "A", "Z", "_", "9", "a", " ", "-", "env:", "${env:", "}"];
    for (let i = 0; i < 20000; i++) {
      let s = "";
      const n = Math.floor(rnd() * 24);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      let parts: ReturnType<typeof parseEnvRefs> | null = null;
      try {
        parts = parseEnvRefs(s);
      } catch (err) {
        expect(s).toContain("${env:");
        expect(String(err)).toMatch(/env/);
        continue;
      }
      if (!s.includes("${env:")) expect(parts.every((p) => p.kind === "literal")).toBe(true);
      // Rendering each reference back as itself reproduces the input exactly.
      expect(rewriteEnvRefs(s, (name) => `\${env:${name}}`)).toBe(s);
    }
  });
});

describe("adapter x field matrix for ${env:VAR} (flyingrobots/agent-hub#6)", () => {
  const stdio: McpServerSpec = { command: "${env:BIN}", args: ["--token", "${env:T}"], env: { T: "${env:T}" } };
  const http: McpServerSpec = { url: "https://h/${env:PATH_PART}", headers: { "X-Key": "${env:KEY}" } };

  test("Claude compiles every field natively as ${VAR}", () => {
    expect(compile("claude", "stdio", stdio)).toEqual({
      type: "stdio",
      command: "${BIN}",
      args: ["--token", "${T}"],
      env: { T: "${T}" },
    });
    expect(compile("claude", "http", http)).toEqual({ type: "http", url: "https://h/${PATH_PART}", headers: { "X-Key": "${KEY}" } });
  });

  test("Cursor compiles every field natively as ${env:VAR}", () => {
    expect(compile("cursor", "stdio", stdio)).toEqual({
      type: "stdio",
      command: "${env:BIN}",
      args: ["--token", "${env:T}"],
      env: { T: "${env:T}" },
    });
    expect(compile("cursor", "http", http)).toEqual({ url: "https://h/${env:PATH_PART}", headers: { "X-Key": "${env:KEY}" } });
  });

  test("OpenCode compiles every field natively as {env:VAR}", () => {
    expect(compile("opencode", "stdio", stdio)).toEqual({
      type: "local",
      command: ["{env:BIN}", "--token", "{env:T}"],
      environment: { T: "{env:T}" },
    });
    expect(compile("opencode", "http", http)).toEqual({ type: "remote", url: "https://h/{env:PATH_PART}", headers: { "X-Key": "{env:KEY}" } });
  });

  test("Antigravity refuses a reference in any field", () => {
    const cells: Array<[McpTransport, McpServerSpec]> = [
      ["stdio", { command: "${env:BIN}" }],
      ["stdio", { command: "/bin/x", args: ["${env:A}"] }],
      ["stdio", { command: "/bin/x", env: { A: "${env:A}" } }],
      ["http", { url: "https://h/${env:P}" }],
      ["http", { url: "https://h", headers: { H: "${env:H}" } }],
    ];
    for (const [t, spec] of cells) expect(() => compile("antigravity", t, spec)).toThrow(/Antigravity does not expand/);
    expect(compile("antigravity", "stdio", { command: "/bin/x", env: { A: "literal" } })).toEqual({
      command: "/bin/x",
      env: { A: "literal" },
      disabled: false,
    });
  });

  test("Codex compiles the exact forms natively: env_vars, bearer_token_env_var, env_http_headers", () => {
    expect(compile("codex", "stdio", { command: "/bin/x", env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", MODE: "fast" } })).toEqual({
      command: "/bin/x",
      env: { MODE: "fast" },
      env_vars: ["GITHUB_TOKEN"],
    });
    expect(
      compile("codex", "http", { url: "https://h", headers: { Authorization: "Bearer ${env:API_TOKEN}", "X-Key": "${env:KEY}", Accept: "json" } }),
    ).toEqual({
      url: "https://h",
      bearer_token_env_var: "API_TOKEN",
      env_http_headers: { "X-Key": "KEY" },
      http_headers: { Accept: "json" },
    });
  });

  test("Codex refuses every other reference", () => {
    const cells: Array<[McpTransport, McpServerSpec]> = [
      ["stdio", { command: "${env:BIN}" }],
      ["stdio", { command: "/bin/x", args: ["${env:A}"] }],
      ["stdio", { command: "/bin/x", env: { A: "${env:B}" } }],
      ["stdio", { command: "/bin/x", env: { A: "pre-${env:A}" } }],
      ["http", { url: "https://h/${env:P}" }],
      ["http", { url: "https://h", headers: { Authorization: "Bearer ${env:X}-suffix" } }],
      ["http", { url: "https://h", headers: { "X-Key": "k ${env:X}" } }],
    ];
    for (const [t, spec] of cells) expect(() => compile("codex", t, spec)).toThrow(/Codex/);
  });

  test("Codex TOML renders env_vars, bearer_token_env_var and env_http_headers and passes the preservation check", () => {
    const entry = compile("codex", "http", {
      url: "https://h",
      headers: { Authorization: "Bearer ${env:API_TOKEN}", "X-Key": "${env:KEY}" },
    });
    const section = renderCodexSection("srv", entry);
    expect(Bun.TOML.parse(section)).toEqual({
      mcp_servers: { srv: { url: "https://h", bearer_token_env_var: "API_TOKEN", env_http_headers: { "X-Key": "KEY" } } },
    });
    const stdioEntry = compile("codex", "stdio", { command: "/bin/x", env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" } });
    const out = rewriteCodexToml('model = "m"\n', new Map([["srv", entry], ["gh", stdioEntry]]));
    expect(Bun.TOML.parse(out)).toEqual({
      model: "m",
      mcp_servers: {
        gh: { command: "/bin/x", env_vars: ["GITHUB_TOKEN"] },
        srv: { url: "https://h", bearer_token_env_var: "API_TOKEN", env_http_headers: { "X-Key": "KEY" } },
      },
    });
  });

  test("an invalid reference is refused for every target", () => {
    for (const agent of ["claude", "cursor", "opencode", "codex", "antigravity"] as const) {
      expect(() => compile(agent, "stdio", { command: "/bin/x", env: { A: "${env:lower}" } })).toThrow(/env/);
    }
  });
});

describe("plaintext secret detector (flyingrobots/agent-hub#6)", () => {
  test("a literal ghp_ token under env.GITHUB_TOKEN warns; a reference does not", () => {
    const literal = detectPlaintextSecrets({ command: "/bin/gh", env: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345" } });
    expect(literal.map((w) => w.field)).toEqual(["env.GITHUB_TOKEN"]);
    expect(detectPlaintextSecrets({ command: "/bin/gh", env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" } })).toEqual([]);
  });

  test("known token patterns warn in any field; secret-bearing names warn on any literal value", () => {
    const fields = (spec: McpServerSpec) => detectPlaintextSecrets(spec).map((w) => w.field).sort();
    expect(fields({ command: "/bin/x", args: ["--key", "sk-abcdefghijklmnopqrstuvwx"] })).toEqual(["args[1]"]);
    expect(fields({ url: "https://h", headers: { Authorization: "Bearer abc123", Accept: "json" } })).toEqual(["headers.Authorization"]);
    expect(fields({ command: "/bin/x", env: { DB_PASSWORD: "hunter2", LOG_LEVEL: "debug" } })).toEqual(["env.DB_PASSWORD"]);
    expect(fields({ url: "https://user:pw@h/x" })).toEqual(["url"]);
    expect(fields({ command: "/bin/x", env: { AWS: "AKIAABCDEFGHIJKLMNOP" } })).toEqual(["env.AWS"]);
    expect(fields({ command: "/bin/x", env: { K: "-----BEGIN RSA PRIVATE KEY-----" } })).toEqual(["env.K"]);
    expect(fields({ command: "/bin/x", env: { SLACK: "xoxb-1234567890-abcdef" } })).toEqual(["env.SLACK"]);
    expect(fields({ command: "/bin/x", env: { G: "AIzaSyA1234567890abcdefghijklmnopqrstu" } })).toEqual(["env.G"]);
    expect(fields({ command: "/bin/x", env: { API_KEY: "" } })).toEqual([]);
  });

  test("allowPlaintextFields suppresses only the named field", () => {
    const spec: McpServerSpec = { command: "/bin/x", env: { API_KEY: "k1", DB_PASSWORD: "p1" } };
    expect(detectPlaintextSecrets(spec, ["env.API_KEY"]).map((w) => w.field)).toEqual(["env.DB_PASSWORD"]);
  });
});

describe("hub mcp.json: allowPlaintextFields and detector wiring (flyingrobots/agent-hub#6)", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { loadCanonicalServers } = require("../src/mcp.ts") as typeof import("../src/mcp.ts");
  function hubWith(doc: unknown) {
    const hub = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-envhub-")));
    mkdirSync(join(hub, "mcp", "gh"), { recursive: true });
    writeFileSync(join(hub, "mcp", "gh", "mcp.json"), JSON.stringify(doc));
    return hub;
  }

  test("loading the hub reports each plaintext field once per server, honouring allowPlaintextFields", () => {
    const hub = hubWith({
      mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345", API_KEY: "k" } },
      allowPlaintextFields: ["env.API_KEY"],
    });
    const warnings: Array<{ server: string; field: string; reason: string; source: string }> = [];
    loadCanonicalServers(hub, undefined, warnings);
    expect(warnings.map((w) => `${w.server}:${w.field}`)).toEqual(["gh:env.GITHUB_TOKEN"]);
    expect(warnings[0]!.source.endsWith("mcp/gh/mcp.json")).toBe(true);
  });

  test("allowPlaintextFields must be an array of field paths", () => {
    for (const bad of ["env.X", [1], [""]]) {
      const hub = hubWith({ mcp: { command: "/bin/gh" }, allowPlaintextFields: bad });
      expect(() => loadCanonicalServers(hub)).toThrow(/allowPlaintextFields/);
    }
  });
});

describe("a plaintext secret blocks the sync (flyingrobots/agent-hub#6, flyingrobots/agent-hub#50)", () => {
  function sb(doc: unknown) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-envsync-")));
    const hub = path.join(home, ".agents");
    fs.mkdirSync(path.join(hub, "mcp", "gh"), { recursive: true });
    fs.mkdirSync(path.join(hub, "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(hub, "mcp", "gh", "mcp.json"), JSON.stringify(doc));
    return {
      home,
      opts: {
        hubDir: hub,
        homeDir: home,
        xdgConfigHome: path.join(home, ".config"),
        xdgStateHome: path.join(home, ".local", "state"),
        targets: [parseTargetSelector("claude:mcp")!],
      },
    };
  }

  test("a literal token is a warning and a conflict per field; nothing is written and the run exits 1", () => {
    const { home, opts } = sb({ mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345" } } });
    for (const mode of [{}, { dryRun: true }, { checkOnly: true }]) {
      const r = runSync({ ...opts, ...mode });
      expect(r.exitCode).toBe(1);
      const warnings = r.events.filter((e) => e.id === "agent_hub.warning");
      expect(warnings.map((w) => [w.stream, w.data.server, w.data.field, w.data.code])).toEqual([["stderr", "gh", "env.GITHUB_TOKEN", "plaintext_secret"]]);
      const conflicts = r.events.filter((e) => e.id === "agent_hub.conflict");
      expect(conflicts.length).toBe(1);
      expect(String(conflicts[0]!.data.reason)).toContain("env.GITHUB_TOKEN");
      expect(String(conflicts[0]!.data.next_step)).toContain("${vault:KEY}");
      expect(JSON.stringify(r.events)).not.toContain("ghp_0123");
    }
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  test("two literal fields give two conflicts, and the summary counts both", () => {
    const { home, opts } = sb({ mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345", API_KEY: "sk-FAKE0123456789abcdefghijklmnop" } } });
    const r = runSync(opts);
    expect(r.exitCode).toBe(1);
    expect(r.events.filter((e) => e.id === "agent_hub.conflict").map((e) => String(e.data.reason).includes("env.API_KEY") || String(e.data.reason).includes("env.GITHUB_TOKEN"))).toEqual([true, true]);
    expect(r.events.find((e) => e.id === "agent_hub.summary")!.data.conflicts).toBe(2);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  test("a plaintext secret in a per-agent override file blocks the sync too", () => {
    const { home, opts } = sb({ mcp: { command: "/bin/gh" } });
    const hub = opts.hubDir;
    fs.mkdirSync(path.join(hub, "mcp", "gh", "claude"), { recursive: true });
    fs.writeFileSync(path.join(hub, "mcp", "gh", "claude", "mcp.json"), JSON.stringify({ mcp: { env: { API_KEY: "sk-FAKE0123456789abcdefghijklmnop" } } }));
    expect(runSync(opts).exitCode).toBe(1);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  test("a vault reference never counts as plaintext", () => {
    const { opts } = sb({ mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "${vault:gh}" } } });
    const r = runSync({ ...opts, dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(r.events.some((e) => e.id === "agent_hub.warning" || e.id === "agent_hub.conflict")).toBe(false);
  });

  test("allowPlaintextFields silences the warning and the conflict; a reference never warns", () => {
    const a = sb({ mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345" } }, allowPlaintextFields: ["env.GITHUB_TOKEN"] });
    const ra = runSync(a.opts);
    expect(ra.exitCode).toBe(0);
    expect(ra.events.some((e) => e.id === "agent_hub.warning" || e.id === "agent_hub.conflict")).toBe(false);
    const b = sb({ mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" } } });
    const r = runSync(b.opts);
    expect(r.exitCode).toBe(0);
    expect(r.events.some((e) => e.id === "agent_hub.warning")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(b.home, ".claude.json"), "utf8")).mcpServers.gh.env.GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
  });

  test("a sync never reads a referenced variable: its value appears in no config and no output", () => {
    const { home, opts } = sb({ mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" } } });
    const sentinel = "sentinel-value-that-must-not-leak-1234567890";
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = sentinel;
    try {
      const r = runSync(opts);
      expect(r.exitCode).toBe(0);
      expect(JSON.stringify(r.events)).not.toContain(sentinel);
      expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).not.toContain(sentinel);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });
});

describe("refusals never print a value (Baker Street PR #33 Holmes F1)", () => {
  test("a malformed reference next to a literal token names the field, not the value", () => {
    const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    for (const value of [`Bearer ${token} \${env:TOK`, `\${env:${token.toLowerCase()}}`]) {
      let message = "";
      try {
        MCP_ADAPTER_BY_ID.claude.compile("http", { url: "https://h", headers: { Authorization: value } }, "srv", "mcp/srv/mcp.json");
      } catch (err) {
        message = String(err);
      }
      expect(message).toContain("headers.Authorization");
      expect(message).not.toContain(token);
      expect(message.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });
});

describe("references through a real sync, every native target (Baker Street PR #33 Holmes F5, F8)", () => {
  function full() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-envall-")));
    const hub = path.join(home, ".agents");
    for (const d of ["skills", "mcp/gh", "mcp/api"]) fs.mkdirSync(path.join(hub, d), { recursive: true });
    for (const d of [".claude", ".cursor", ".codex", ".config/opencode"]) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(hub, "mcp", "gh", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/gh", env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" } } }));
    fs.writeFileSync(
      path.join(hub, "mcp", "api", "mcp.json"),
      JSON.stringify({ mcp: { transport: "http", url: "https://api.invalid/mcp", headers: { Authorization: "Bearer ${env:API_TOKEN}" } } }),
    );
    const mcp = ["claude", "cursor", "codex", "opencode"].map((t) => parseTargetSelector(`${t}:mcp`)!);
    return { home, hub, opts: { hubDir: hub, homeDir: home, xdgConfigHome: path.join(home, ".config"), xdgStateHome: path.join(home, ".local", "state"), targets: mcp } };
  }

  test("Claude, Cursor, OpenCode and Codex each get their native form, and a second run changes nothing", () => {
    const { home, opts } = full();
    expect(runSync(opts).exitCode).toBe(0);
    const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers;
    expect(claude.gh.env.GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
    expect(claude.api.headers.Authorization).toBe("Bearer ${API_TOKEN}");
    const cursor = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers;
    expect(cursor.gh.env.GITHUB_TOKEN).toBe("${env:GITHUB_TOKEN}");
    const oc = JSON.parse(fs.readFileSync(path.join(home, ".config", "opencode", "opencode.json"), "utf8")).mcp.servers;
    expect(oc.gh.environment.GITHUB_TOKEN).toBe("{env:GITHUB_TOKEN}");
    expect(oc.api.headers.Authorization).toBe("Bearer {env:API_TOKEN}");
    const codex = Bun.TOML.parse(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    expect(codex.mcp_servers.gh).toEqual({ command: "/bin/gh", env_vars: ["GITHUB_TOKEN"] });
    expect(codex.mcp_servers.api).toEqual({ url: "https://api.invalid/mcp", bearer_token_env_var: "API_TOKEN" });
    const again = runSync(opts);
    expect(again.events.filter((e) => e.id === "agent_hub.op" && e.data.phase === "sync")).toEqual([]);
    expect(runSync({ ...opts, checkOnly: true }).exitCode).toBe(0);
  });

  test("a warning names the file that sets the field: a per-target mcp.json, not the base", () => {
    const { hub, opts } = full();
    fs.mkdirSync(path.join(hub, "mcp", "gh", "cursor"), { recursive: true });
    fs.writeFileSync(path.join(hub, "mcp", "gh", "cursor", "mcp.json"), JSON.stringify({ mcp: { env: { GITHUB_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345" } } }));
    const w = runSync({ ...opts, dryRun: true }).events.filter((e) => e.id === "agent_hub.warning");
    expect(w.map((e) => String(e.data.source).endsWith(path.join("mcp", "gh", "cursor", "mcp.json")))).toEqual([true]);
  });
});

describe("Baker Street PR #33 Moriarty repairs", () => {
  const codex = (t: McpTransport, spec: McpServerSpec) => compile("codex", t, spec);
  test("Codex refuses a header set twice in different case, and a reference with text after it in any header", () => {
    expect(() => codex("http", { url: "https://h", headers: { authorization: "Bearer ${env:X}", Authorization: "Bearer ${env:Y}" } })).toThrow(/twice/);
    expect(() => codex("http", { url: "https://h", headers: { "X-Key": "${env:X}-suffix" } })).toThrow(/Codex/);
    // Bearer mapping is for Authorization only.
    expect(() => codex("http", { url: "https://h", headers: { "X-Token": "Bearer ${env:X}" } })).toThrow(/Codex/);
  });

  test("a Codex env key that is not a variable name gets a refusal that says so", () => {
    expect(() => codex("stdio", { command: "/x", env: { "A.B": "${env:AB}" } })).toThrow(/not a valid variable name/);
  });

  test("Codex env_vars compare as a set, sorted on write", () => {
    const out = codex("stdio", { command: "/x", env: { ZED: "${env:ZED}", ALPHA: "${env:ALPHA}" } });
    expect(out.env_vars).toEqual(["ALPHA", "ZED"]);
    const { normalizeCodexComparable } = require("../src/toml-edit.ts") as typeof import("../src/toml-edit.ts");
    expect(normalizeCodexComparable({ command: "/x", env_vars: ["ZED", "ALPHA"] })).toEqual(normalizeCodexComparable({ command: "/x", env_vars: ["ALPHA", "ZED"] }));
    expect(normalizeCodexComparable({ command: "/x", env_vars: [] })).toEqual({ command: "/x" });
  });

  test("only fields the transport writes are checked for Antigravity and Codex", () => {
    expect(() => compile("antigravity", "stdio", { command: "/x", headers: { H: "${env:H}" } })).not.toThrow(/expand/);
    expect(() => codex("http", { url: "https://h", command: "${env:C}" })).not.toThrow(/command/);
  });

  test("common non-secret names do not warn; the docs' Bearer reference does not warn", () => {
    const names = ["GIT_AUTHOR_NAME", "MAX_TOKENS", "AUTH_MODE", "OAUTH_CLIENT_ID", "SESSION_DIR", "COOKIE_DOMAIN"];
    const env = Object.fromEntries(names.map((n) => [n, "value"]));
    expect(detectPlaintextSecrets({ command: "/x", env, headers: undefined })).toEqual([]);
    expect(detectPlaintextSecrets({ url: "https://h", headers: { "X-Session-Id": "abc", Authorization: "Bearer ${env:EXAMPLE_TOKEN}" } })).toEqual([]);
    expect(detectPlaintextSecrets({ command: "/x", env: { ACCESS_KEY: "v", "X-Api-Key": "v" } }).map((w) => w.field).sort()).toEqual(["env.ACCESS_KEY", "env.X-Api-Key"]);
    // Text on both sides of a reference is not one token.
    expect(detectPlaintextSecrets({ command: "/x", args: ["sk-abcdefgh${env:X}ijklmnopqrst"] })).toEqual([]);
  });

  test("a Codex refusal names the server and its source", () => {
    expect(() => compile("codex", "stdio", { command: "/x", env: { A: "${env:lower}" } })).toThrow(/mcp\/srv\/mcp\.json: MCP "srv"/);
  });

  test("an Authorization header spelled twice is refused for Codex wherever it sits among the headers", () => {
    for (const headers of [
      { "A-A": "1", "a-a": "2", authorization: "Bearer ${env:X}", Authorization: "Bearer ${env:Y}" },
      { "A-A": "1", "a-a": "2", Authorization: "Bearer ${env:X}", authorization: "Basic lit" },
    ]) {
      expect(() => codex("http", { url: "https://h", headers })).toThrow(/twice/);
    }
  });

  test("credential names in camelCase, compound or header form still warn", () => {
    const names = ["accessToken", "authToken", "clientSecret", "refreshToken", "PGPASSWORD", "AUTH_KEY", "SESSION_KEY", "SECRETKEY", "DB_PASS", "PASSPHRASE", "GITHUB_PAT", "BEARER", "API_KEY", "AUTH_TOKEN"];
    const env = Object.fromEntries(names.map((n) => [n, "value"]));
    expect(detectPlaintextSecrets({ command: "/x", env }).map((w) => w.field.slice(4)).sort()).toEqual([...names].sort());
    expect(detectPlaintextSecrets({ url: "https://h", headers: { Cookie: "c=1", "X-Auth-Key": "k" } }).map((w) => w.field).sort()).toEqual(["headers.Cookie", "headers.X-Auth-Key"]);
  });
});

describe("a malformed reference names the file that holds it (flyingrobots/agent-hub#40)", () => {
  test("in a per-target mcp.json, the error names that file, not the base", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-src-")));
    const hub = path.join(home, ".agents");
    fs.mkdirSync(path.join(hub, "mcp", "gh", "cursor"), { recursive: true });
    fs.mkdirSync(path.join(hub, "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(hub, "mcp", "gh", "mcp.json"), JSON.stringify({ mcp: { command: "/bin/gh" } }));
    fs.writeFileSync(path.join(hub, "mcp", "gh", "cursor", "mcp.json"), JSON.stringify({ mcp: { env: { A: "${env:lower}" } } }));
    const r = runSync({ hubDir: hub, homeDir: home, xdgConfigHome: path.join(home, ".config"), xdgStateHome: path.join(home, ".local", "state"), targets: [parseTargetSelector("cursor:mcp")!] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.join("\n")).toContain(path.join("mcp", "gh", "cursor", "mcp.json"));
    expect(r.stderr.join("\n")).toContain("env.A");
  });
});
