import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function markdownFiles(): string[] {
  const out = [join(REPO_ROOT, "README.md"), join(REPO_ROOT, "CHANGELOG.md")];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(join(REPO_ROOT, "docs"));
  return out.filter((p) => existsSync(p));
}

/** GitHub-style heading anchors for a Markdown file. */
function anchorsOf(file: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const slug = m[1]!
      .trim()
      .toLowerCase()
      .replace(/[`*_]/g, "")
      .replace(/[^\p{L}\p{N} -]/gu, "")
      .replace(/ /g, "-");
    anchors.add(slug);
  }
  return anchors;
}

/** Exact test names declared with test("...") in each test file. */
function declaredTests(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const f of readdirSync(join(REPO_ROOT, "test"))) {
    if (!f.endsWith(".test.ts")) continue;
    const src = readFileSync(join(REPO_ROOT, "test", f), "utf8");
    const names = new Set<string>();
    // test("…") and conditional forms such as test.skipIf(cond)("…").
    for (const m of src.matchAll(/\btest(?:\.(?:skipIf|if|todoIf)\([^()]*\))?\(\s*("(?:[^"\\]|\\.)*")/g)) {
      names.add(JSON.parse(m[1]!) as string);
    }
    // Table-driven tests declare their names as fixture fields and run test(c.name, ...).
    if (/\btest\(\s*c\.name\b/.test(src)) {
      for (const m of src.matchAll(/^\s+name:\s*("(?:[^"\\]|\\.)*"),/gm)) {
        names.add(JSON.parse(m[1]!) as string);
      }
    }
    byFile.set(f, names);
  }
  return byFile;
}

describe("documentation gate", () => {
  test("every relative link and anchor in README.md, CHANGELOG.md and docs/ resolves", () => {
    const broken: string[] = [];
    for (const file of markdownFiles()) {
      const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1]!;
        if (/^[a-z]+:/i.test(href)) continue; // http:, https:, mailto:
        const [pathPart, anchor] = href.split("#") as [string, string | undefined];
        const target = pathPart === "" ? file : resolve(dirname(file), pathPart);
        const where = `${relative(REPO_ROOT, file)} -> ${href}`;
        if (!existsSync(target)) {
          broken.push(`${where} (missing file)`);
          continue;
        }
        if (anchor !== undefined) {
          const anchorFile = statSync(target).isDirectory() ? join(target, "README.md") : target;
          if (!anchorFile.endsWith(".md") || !anchorsOf(anchorFile).has(anchor)) {
            broken.push(`${where} (missing anchor)`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("every requirement ID in a docs test-plan.md is unique within its ledger", () => {
    const dups: string[] = [];
    for (const f of markdownFiles().filter((x) => x.endsWith("test-plan.md"))) {
      const seen = new Set<string>();
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const id = /^\| ([A-Z]+(?:-[A-Z0-9]+)+) \|/.exec(line)?.[1];
        if (!id) continue;
        if (seen.has(id)) dups.push(`${f}: ${id}`);
        seen.add(id);
      }
    }
    expect(dups).toEqual([]);
  });

  test("every test cited in a docs test-plan.md exists with that exact name", () => {
    const declared = declaredTests();
    const plans = markdownFiles().filter((f) => f.endsWith("test-plan.md"));
    expect(plans.length).toBeGreaterThan(0);
    const missing: string[] = [];
    let cited = 0;
    for (const plan of plans) {
      const text = readFileSync(plan, "utf8");
      for (const m of text.matchAll(/`([\w.-]+\.test\.ts) › ([^`]+)`/g)) {
        cited++;
        const names = declared.get(m[1]!);
        if (!names?.has(m[2]!)) missing.push(`${relative(REPO_ROOT, plan)}: ${m[1]} › ${m[2]}`);
      }
    }
    expect(cited).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("docs/README.md routes to every durable page under docs/", () => {
    const spine = join(REPO_ROOT, "docs", "README.md");
    expect(existsSync(spine)).toBe(true);
    const text = readFileSync(spine, "utf8");
    const linked = new Set(
      [...text.matchAll(/\]\(([^)#\s]+)/g)].map((m) => resolve(dirname(spine), m[1]!)),
    );
    const pages = markdownFiles().filter(
      (f) => f.startsWith(join(REPO_ROOT, "docs")) && f !== spine,
    );
    const unrouted = pages.filter((p) => !linked.has(p)).map((p) => relative(REPO_ROOT, p));
    expect(unrouted).toEqual([]);
  });
});
