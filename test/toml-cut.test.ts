import { describe, expect, test } from "bun:test";
import { rewriteCodexToml, scanTomlDocument, sectionCut, tomlCutFallbacks } from "../src/toml-edit.ts";

// The cut search as it stood before flyingrobots/agent-hub#19, kept verbatim as the oracle the
// scanner-based cut must reproduce byte for byte.
function referenceContentEnd(src: string, start: number, end: number): number {
  let lineEnd = end;
  while (lineEnd > start) {
    let lineStart = lineEnd;
    if (src[lineStart - 1] === "\n") lineStart--;
    if (src[lineStart - 1] === "\r") lineStart--;
    while (lineStart > start && src[lineStart - 1] !== "\n") lineStart--;
    const text = src.slice(lineStart, lineEnd).trim();
    if (text.length > 0 && !text.startsWith("#")) return lineEnd;
    if (lineStart === lineEnd) break;
    lineEnd = lineStart;
  }
  return end;
}
function referenceSafeContentEnd(src: string, start: number, end: number): number {
  let parsedFull: unknown;
  try {
    parsedFull = Bun.TOML.parse(src.slice(start, end));
  } catch {
    return end;
  }
  const full = JSON.stringify(parsedFull);
  const sameValue = (cut: number): boolean => {
    try {
      return JSON.stringify(Bun.TOML.parse(src.slice(start, cut))) === full;
    } catch {
      return false;
    }
  };
  let cut = referenceContentEnd(src, start, end);
  while (cut < end && !sameValue(cut)) {
    const nl = src.indexOf("\n", cut);
    cut = nl === -1 || nl + 1 > end ? end : nl + 1;
  }
  return cut;
}

// Document generator from the PR #16 differential fuzz (Baker Street case agent-hub-pr16-r1).
function generator(seed: number) {
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const chance = (p: number) => rnd() < p;
  const COMMENTS = ["# note", "# it's \"q\"", '# use """ for prompts', "# don't'''", "# [not.a.header]", "#", "  # indented", "# key = 1"];
  const gap = (lines: string[]) => {
    const n = Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) lines.push(chance(0.5) ? pick(["", "  ", "\t"]) : pick(COMMENTS));
  };
  return () => {
    const lines: string[] = [];
    const servers = ["a", "b", "c", "my.srv"].filter(() => chance(0.7));
    const userTables = ["profiles.fast", "user", "tools.x"].filter(() => chance(0.7));
    if (chance(0.6)) lines.push('model = "gpt-5"');
    if (chance(0.3)) lines.push('instructions = """\nline\n# hash line inside string\n"""');
    gap(lines);
    const blocks: Array<() => void> = [];
    for (const s of servers) {
      const key = s.includes(".") ? `"${s}"` : s;
      blocks.push(() => {
        lines.push(`[mcp_servers.${key}]`, `command = "/bin/${s}"`);
        if (chance(0.3)) lines.push('args = ["x", "y"]');
        if (chance(0.15)) lines.push('args = [\n  "m",\n  # inner\n]');
        if (chance(0.1)) lines.push("args = ['''\n# hash''']");
        if (chance(0.1)) lines.push('args = ["""\nfoo\n\n"""]');
        if (chance(0.1)) lines.push('note = """\n# a\n  # b\n"""');
        gap(lines);
      });
      if (chance(0.4)) blocks.push(() => { lines.push(`[mcp_servers.${key}.env]`, 'K = "v"'); gap(lines); });
      if (chance(0.2)) blocks.push(() => { lines.push(`[mcp_servers.${key}.http_headers]`, 'H = "h"'); gap(lines); });
    }
    for (const t of userTables) blocks.push(() => { lines.push(`[${t}]`, `k = "v" # inline 'c' """`); gap(lines); });
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
    }
    for (const b of blocks) b();
    let text = lines.join("\n") + (chance(0.8) ? "\n" : "");
    if (chance(0.3)) text = text.replace(/\n/g, "\r\n");
    return text;
  };
}

function longStringDoc(n: number, eol = "\n"): string {
  const body = Array.from({ length: n }, (_, i) => `# line ${i}`).join(eol);
  // The closing quotes sit on a #-led line, so every line of the string looks like a comment to a
  // line-based search: the case that made the previous cut search quadratic.
  return `[mcp_servers.x]${eol}command = "/bin/x"${eol}note = """${eol}${body}"""${eol}# trailing user comment${eol}[profiles.fast]${eol}model = "o3"${eol}`;
}

describe("Codex TOML cut from the scanner's string state (flyingrobots/agent-hub#19)", () => {
  test("cuts match the previous parse-equivalence search on the PR #16 fuzz corpus (seeds 1-3) with zero fallbacks", () => {
    const before = tomlCutFallbacks();
    let compared = 0;
    for (const seed of [1, 2, 3]) {
      const gen = generator(seed);
      for (let it = 0; it < 2000; it++) {
        const text = gen();
        try {
          Bun.TOML.parse(text);
        } catch {
          continue;
        }
        for (const sec of scanTomlDocument(text).sections) {
          if (sec.headerPath[0] !== "mcp_servers") continue;
          expect(sectionCut(text, sec)).toBe(referenceSafeContentEnd(text, sec.startOffset, sec.endOffset));
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(5000);
    expect(tomlCutFallbacks() - before).toBe(0);
  });

  test("a multiline string of 3000 #-led lines in a managed table is cut after the string, quickly, LF and CRLF", () => {
    for (const eol of ["\n", "\r\n"]) {
      const doc = longStringDoc(3000, eol);
      const sec = scanTomlDocument(doc).sections[0]!;
      const t0 = performance.now();
      const cut = sectionCut(doc, sec);
      const ms = performance.now() - t0;
      expect(cut).toBe(referenceSafeContentEnd(doc, sec.startOffset, sec.endOffset));
      expect(doc.slice(cut).startsWith(`# trailing user comment${eol}`)).toBe(true);
      expect(ms).toBeLessThan(50);
      const out = rewriteCodexToml(doc, new Map([["x", { command: "/new/x" }]]));
      expect(out).toContain(`# trailing user comment${eol}[profiles.fast]`);
      expect(out).not.toContain("# line 0");
    }
  });

  test("a literal multiline string whose last lines start with # is never cut inside", () => {
    const doc = "[mcp_servers.x]\ncommand = '''\n/bin/x\n# not a comment\n'''\n# user\n[u]\nk = 1\n";
    const sec = scanTomlDocument(doc).sections[0]!;
    const cut = sectionCut(doc, sec);
    expect(doc.slice(cut)).toBe("# user\n[u]\nk = 1\n");
    expect(cut).toBe(referenceSafeContentEnd(doc, sec.startOffset, sec.endOffset));
  });
});
