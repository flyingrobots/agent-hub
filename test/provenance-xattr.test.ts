// macOS stamps files written by some processes with com.apple.provenance, a record of which
// application wrote them. It is not part of a file's content, so adoption equivalence ignores it.
// Oracle: docs/topics/ownership/README.md, "Adoption".
import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readEntryMetadata } from "../src/metadata.ts";
import { decodeOutput } from "./jsonl.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SYNC_BIN = process.env.AGENT_HUB_BINARY || join(REPO_ROOT, "bin", "sync-agents");
const PROVENANCE = "com.apple.provenance";
const PROVENANCE_HEX = "010200effd83ac4f4e34e7";
const onDarwin = process.platform === "darwin";
const tempRoots: string[] = [];

function setXattrHex(path: string, name: string, hex: string): void {
  const res = Bun.spawnSync(["/usr/bin/xattr", "-wx", name, hex, path]);
  if (res.exitCode !== 0) throw new Error(`xattr -wx ${name} failed for ${path}: ${res.stderr.toString()}`);
}

/** A hub skill and an identical real directory where Claude's link to it belongs. */
function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-prov-")));
  tempRoots.push(home);
  const hubSkill = join(home, ".agents", "skills", "one");
  const copy = join(home, ".claude", "skills", "one");
  for (const dir of [hubSkill, copy]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: one\n---\n# One\n");
  }
  writeFileSync(join(home, ".agents", "AGENTS.md"), "# Rules\n");
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  return { hubSkill, copy, env };
}

function adopt(env: Record<string, string>) {
  const proc = Bun.spawnSync([SYNC_BIN, "--adopt", "--targets", "claude:links"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, ...decodeOutput(proc.stdout.toString(), proc.stderr.toString()) };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe.skipIf(!onDarwin)("com.apple.provenance and adoption (macOS)", () => {
  test("--adopt replaces an identical copy with a link when only the hub side carries com.apple.provenance", () => {
    const { hubSkill, copy, env } = makeSandbox();
    setXattrHex(hubSkill, PROVENANCE, PROVENANCE_HEX);
    setXattrHex(join(hubSkill, "SKILL.md"), PROVENANCE, PROVENANCE_HEX);
    // Strip it from the copy, in case this test process is itself one whose files macOS stamps.
    Bun.spawnSync(["/usr/bin/xattr", "-dr", PROVENANCE, copy]);

    const result = adopt(env);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(lstatSync(copy).isSymbolicLink()).toBe(true);
  });

  test("--adopt still refuses a copy when another extended attribute differs", () => {
    const { hubSkill, copy, env } = makeSandbox();
    setXattrHex(join(hubSkill, "SKILL.md"), "test.attr", "41");

    const result = adopt(env);

    expect(result.exitCode).toBe(1);
    expect(lstatSync(copy).isDirectory()).toBe(true);
  });

  test("readEntryMetadata omits com.apple.provenance and keeps other extended attributes", () => {
    const { hubSkill } = makeSandbox();
    const file = join(hubSkill, "SKILL.md");
    setXattrHex(file, PROVENANCE, PROVENANCE_HEX);
    setXattrHex(file, "test.attr", "41");

    const meta = readEntryMetadata(file, false);

    expect(meta.ok).toBe(true);
    if (meta.ok) expect(meta.xattrs).toEqual({ "test.attr": "41" });
  });
});
