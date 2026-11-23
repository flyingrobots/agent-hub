import { describe, expect, test } from "bun:test";
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
