import { describe, expect, test } from "bun:test";
import {
  rewriteCodexToml,
  TomlPreservationError,
  TomlUnsupportedError,
  verifyTomlPreservation,
} from "../src/toml-edit.ts";

describe("toml-edit: lexical scanner, refusal, and semantic preservation", () => {
  test("preserves multiline basic strings (\"\"\") containing [mcp_servers.demo] verbatim", () => {
    const prompt = 'intro\n[mcp_servers.demo]\ncommand = "fake"\n[other]\noutro\n';
    const original = [
      'model = "gpt-5"',
      `prompt = """\n${prompt}"""`,
      "",
      "[tui]",
      "animations = true",
      "",
      "[mcp_servers.demo]",
      'command = "/old/demo"',
      "",
      "[mcp_servers.keep]",
      'command = "/keep/me"',
      "",
    ].join("\n");

    const updates = new Map<string, Record<string, unknown> | null>([
      ["demo", { command: "/new/demo", args: ["--serve"] }],
    ]);

    const rewritten = rewriteCodexToml(original, updates);
    const parsed = Bun.TOML.parse(rewritten) as Record<string, any>;

    expect(parsed.model).toBe("gpt-5");
    expect(parsed.prompt).toBe(prompt);
    expect(parsed.tui).toEqual({ animations: true });
    expect(parsed.mcp_servers.keep).toEqual({ command: "/keep/me" });
    expect(parsed.mcp_servers.demo).toEqual({ command: "/new/demo", args: ["--serve"] });
  });

  test("preserves multiline literal strings (''') containing [mcp_servers.demo] verbatim", () => {
    const literalNote = "raw:\n[mcp_servers.demo]\ncommand = 'not-a-table'\n[next]\nend\n";
    const original = [
      `note = '''\n${literalNote}'''`,
      "",
      "[mcp_servers.demo]",
      'command = "/old/demo"',
      "",
    ].join("\n");

    const rewritten = rewriteCodexToml(
      original,
      new Map<string, Record<string, unknown> | null>([["demo", null]]),
    );
    const parsed = Bun.TOML.parse(rewritten) as Record<string, any>;
    expect(parsed.note).toBe(literalNote);
    expect(parsed.mcp_servers).toBeUndefined();
  });

  test("handles bare, double-quoted, and single-quoted keys and arbitrary subtables", () => {
    const original = [
      "[tui]",
      "animations = true",
      "",
      `[mcp_servers."a.b"]`,
      'command = "/old/ab"',
      "",
      `[mcp_servers."a.b".env]`,
      'OLD = "1"',
      "",
      `[mcp_servers."a.b".extra_custom]`,
      'stale = true',
      "",
      "[mcp_servers.'single-key']",
      'command = "/old/single"',
      "",
      "[mcp_servers.untouched]",
      'command = "/stay"',
      "",
    ].join("\n");

    const updates = new Map<string, Record<string, unknown> | null>([
      ["a.b", { command: "/new/ab", env: { FRESH: "2" } }],
      ["single-key", null],
    ]);

    const rewritten = rewriteCodexToml(original, updates);
    const parsed = Bun.TOML.parse(rewritten) as Record<string, any>;

    expect(parsed.tui).toEqual({ animations: true });
    expect(parsed.mcp_servers["a.b"]).toEqual({ command: "/new/ab", env: { FRESH: "2" } });
    expect(parsed.mcp_servers["single-key"]).toBeUndefined();
    expect(parsed.mcp_servers.untouched).toEqual({ command: "/stay" });
  });

  test("refuses unsupported inline table, dotted root key, bare [mcp_servers], and [[mcp_servers]]", () => {
    const inlineRoot = 'mcp_servers = { demo = { command = "/old" } }\n';
    expect(() =>
      rewriteCodexToml(inlineRoot, new Map([["demo", { command: "/new" }]])),
    ).toThrow(TomlUnsupportedError);

    const dottedRoot = 'mcp_servers.demo.command = "/old"\n';
    expect(() =>
      rewriteCodexToml(dottedRoot, new Map([["demo", { command: "/new" }]])),
    ).toThrow(TomlUnsupportedError);

    const bareTable = '[mcp_servers]\ndemo = { command = "/old" }\n';
    expect(() =>
      rewriteCodexToml(bareTable, new Map([["demo", { command: "/new" }]])),
    ).toThrow(TomlUnsupportedError);

    const arrayTable = '[[mcp_servers.demo]]\ncommand = "/old"\n';
    expect(() =>
      rewriteCodexToml(arrayTable, new Map([["demo", { command: "/new" }]])),
    ).toThrow(TomlUnsupportedError);
  });

  test("semantic preservation guard rejects deliberate mutation of unrelated parsed values", () => {
    const original = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.demo]",
      'command = "/old"',
      "",
      "[mcp_servers.keep]",
      'command = "/keep"',
      "",
    ].join("\n");

    // Deliberately mutate unrelated `model` while updating `demo`
    const mutatedTopLevel = [
      'model = "mutated-model"',
      "",
      "[mcp_servers.demo]",
      'command = "/new"',
      "",
      "[mcp_servers.keep]",
      'command = "/keep"',
      "",
    ].join("\n");

    expect(() =>
      verifyTomlPreservation(original, mutatedTopLevel, new Map([["demo", { command: "/new" }]])),
    ).toThrow(TomlPreservationError);

    // Deliberately mutate unmodified `mcp_servers.keep`
    const mutatedSibling = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.demo]",
      'command = "/new"',
      "",
      "[mcp_servers.keep]",
      'command = "/tampered"',
      "",
    ].join("\n");

    expect(() =>
      verifyTomlPreservation(original, mutatedSibling, new Map([["demo", { command: "/new" }]])),
    ).toThrow(TomlPreservationError);
  });
});

describe("toml-edit: comments and placement around managed sections (flyingrobots/agent-hub#15)", () => {
  const src = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.x]",
    'command = "/bin/x"',
    "",
    "# my note about profiles",
    "[profiles.fast]",
    'model = "o3"',
    "",
  ].join("\n");

  test("updating a managed section keeps the comment after it and keeps its position", () => {
    const out = rewriteCodexToml(src, new Map([["x", { command: "/bin/x2" }]]));
    expect(out).toContain("# my note about profiles\n[profiles.fast]");
    expect(out.indexOf("[mcp_servers.x]")).toBeLessThan(out.indexOf("[profiles.fast]"));
    expect(out).toContain('command = "/bin/x2"');
  });

  test("pruning a managed section keeps the comment after it", () => {
    const out = rewriteCodexToml(src, new Map([["x", null]]));
    expect(out).not.toContain("[mcp_servers.x]");
    expect(out).toContain("# my note about profiles\n[profiles.fast]");
  });

  test("a trailing comment at end of file after a managed section survives", () => {
    const tail = '[mcp_servers.x]\ncommand = "/bin/x"\n\n# end-of-file note\n';
    const out = rewriteCodexToml(tail, new Map([["x", { command: "/bin/y" }]]));
    expect(out).toContain("# end-of-file note");
    expect(out).toContain('command = "/bin/y"');
  });

  test("CRLF documents keep CRLF and the following comment", () => {
    const crlf = src.replace(/\n/g, "\r\n");
    const out = rewriteCodexToml(crlf, new Map([["x", { command: "/bin/x2" }]]));
    expect(out).toContain("# my note about profiles\r\n[profiles.fast]");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("a new server is appended after existing content", () => {
    const out = rewriteCodexToml(src, new Map([["z", { command: "/bin/z" }]]));
    expect(out.indexOf("[mcp_servers.z]")).toBeGreaterThan(out.indexOf("[profiles.fast]"));
    expect(out).toContain("# my note about profiles");
  });

  test("a multiline string whose last line starts with # is never split from its section", () => {
    const ml = '[mcp_servers.x]\ncommand = "/bin/x"\nargs = ["""\n# not a comment"""]\n\n[profiles.fast]\nmodel = "o3"\n';
    const out = rewriteCodexToml(ml, new Map([["x", { command: "/bin/y" }]]));
    expect(() => Bun.TOML.parse(out)).not.toThrow();
    expect(out).not.toContain("# not a comment");
    expect(out).toContain("[profiles.fast]");
  });
});
