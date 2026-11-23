import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyFlockErrno,
  ERRNO_MAP,
  flockFdWithErrno,
  LockBusyError,
  LockSystemError,
} from "../src/lock.ts";
import { classifyLinuxXattrErrno, readEntryMetadata } from "../src/metadata.ts";
import { computeEquivalenceRecord } from "../src/paths.ts";
import { applySkillInstall, parseYamlScalar, planSkillInstalls } from "../src/skills.ts";
import { createEmptyState, getStatePaths, loadOwnershipState, loadPendingJournal } from "../src/state.ts";
import { decodeTomlBasicString, rewriteCodexToml, scanTomlDocument } from "../src/toml-edit.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
// AGENT_HUB_BINARY runs this suite against a compiled binary instead of the source wrapper.
const SYNC_BIN = process.env.AGENT_HUB_BINARY || join(REPO_ROOT, "bin", "sync-agents");
const MCP_SYNC = join(REPO_ROOT, "src", "mcp-sync.ts");
const INSTALL_SH = join(REPO_ROOT, "install.sh");
// install.sh copies a runtime and syncs; ~3 s alone, so the 5 s default flakes under a full parallel suite.
const INSTALLER_TIMEOUT_MS = 30_000;
const tempRoots: string[] = [];

function makeSandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-hard-")));
  tempRoots.push(home);
  const hub = join(home, ".agents");
  mkdirSync(join(hub, "skills"), { recursive: true });
  mkdirSync(join(hub, "mcp"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".codex", "skills"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "skills"), { recursive: true });

  writeFileSync(join(hub, "AGENTS.md"), "# Rules\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ userId: "u1" }, null, 2) + "\n");
  chmodSync(join(home, ".claude.json"), 0o600);
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  chmodSync(join(home, ".codex", "config.toml"), 0o600);

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  return { home, hub, env };
}

function runCmd(cmd: string[], env: Record<string, string | undefined>, cwd?: string) {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("hardening regressions (v4 code-review findings)", () => {
  test("F1: mcp-sync.ts delegates to runSync — --explain works, --dir= works, missing --dir arg exits 2", () => {
    const { hub, env } = makeSandbox();
    mkdirSync(join(hub, "mcp", "demo"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "demo", "mcp.json"),
      JSON.stringify({ mcp: { command: "/bin/demo" } }),
    );

    const rExplain = runCmd(["bun", MCP_SYNC, `--dir=${hub}`, "--explain"], env);
    expect(rExplain.exitCode).toBe(0);
    expect(rExplain.stdout).toContain("[explain] mcp");
    expect(rExplain.stdout).not.toContain("[explain] link");

    const rMissing = runCmd(["bun", MCP_SYNC, "--dir"], env);
    expect(rMissing.exitCode).toBe(2);
    expect(rMissing.stderr).toContain("--dir requires a path argument");
  });

  test("F2: flock(2) errno inspection distinguishes EWOULDBLOCK from EBADF/ENOLCK/EOPNOTSUPP", () => {
    const { home } = makeSandbox();
    const probeFile = join(home, "lock-probe");
    const fd = openSync(probeFile, "w");
    closeSync(fd);

    // Calling flock on a closed fd MUST produce EBADF -> LockSystemError (NOT LockBusyError!)
    const res = flockFdWithErrno(fd, 0x02 | 0x04);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errno).toBe(ERRNO_MAP.EBADF);
      const err = classifyFlockErrno(res.errno, probeFile);
      expect(err).toBeInstanceOf(LockSystemError);
      expect(err).not.toBeInstanceOf(LockBusyError);
      expect(err.message).toContain("EBADF");
    }

    // Synthetic Linux/macOS non-contention errnos NEVER classify as LockBusyError
    expect(classifyFlockErrno(37, probeFile, "", "linux")).toBeInstanceOf(LockSystemError); // ENOLCK
    expect(classifyFlockErrno(95, probeFile, "", "linux")).toBeInstanceOf(LockSystemError); // EOPNOTSUPP
    expect(classifyFlockErrno(11, probeFile, "", "linux")).toBeInstanceOf(LockBusyError); // EAGAIN
    expect(classifyFlockErrno(77, probeFile, "", "darwin")).toBeInstanceOf(LockSystemError); // ENOLCK
    expect(classifyFlockErrno(45, probeFile, "", "darwin")).toBeInstanceOf(LockSystemError); // ENOTSUP
    expect(classifyFlockErrno(35, probeFile, "", "darwin")).toBeInstanceOf(LockBusyError); // EAGAIN
  });

  test("F3 & F12: cyclic symlinks and escaping/absolute symlinks in skills & archives are rejected safely", () => {
    const { home, hub, env } = makeSandbox();

    // 1. Cyclic symlink as single child inside skill dir
    const cyc = join(home, "cyclic-skill");
    mkdirSync(cyc, { recursive: true });
    symlinkSync(".", join(cyc, "loop"));
    const rCyc = runCmd([SYNC_BIN, "--skill", cyc], env);
    expect(rCyc.exitCode).toBe(1);
    expect(rCyc.stderr).toContain("refusing to traverse top-level symlink");
    expect(rCyc.stderr).not.toContain("Maximum call stack size exceeded");

    // 2. Escaping relative symlink inside a tarball archive
    const tarSrc = join(home, "evil-tar-src");
    mkdirSync(join(tarSrc, "scripts"), { recursive: true });
    writeFileSync(join(tarSrc, "SKILL.md"), "---\nname: evil-tar\n---\n# Evil\n");
    symlinkSync("../../../../etc/passwd", join(tarSrc, "scripts", "leak"));
    const tarFile = join(home, "evil.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tarFile, "-C", home, "evil-tar-src"]).exitCode).toBe(0);

    const rTar = runCmd([SYNC_BIN, "--skill", tarFile], env);
    expect(rTar.exitCode).toBe(1);
    expect(rTar.stderr).toContain("escaping relative symlink");
    expect(existsSync(join(hub, "skills", "evil-tar"))).toBe(false);

    // 3. Absolute symlink inside skill dir
    const absSkill = join(home, "abs-link-skill");
    mkdirSync(absSkill, { recursive: true });
    writeFileSync(join(absSkill, "SKILL.md"), "---\nname: abs-link\n---\n# Abs\n");
    symlinkSync("/etc/hosts", join(absSkill, "hosts"));
    const rAbs = runCmd([SYNC_BIN, "--skill", absSkill], env);
    expect(rAbs.exitCode).toBe(1);
    expect(rAbs.stderr).toContain("unsafe absolute symlink");
    expect(existsSync(join(hub, "skills", "abs-link"))).toBe(false);
  });

  test("F4: applySkillInstall cleans up .staging-* on mid-install failure (zero leaks in <hub>/skills)", () => {
    const { home, hub } = makeSandbox();
    const src = join(home, "src-leak");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: leak-test\n---\n# Leak\n");

    const staged = planSkillInstalls([src], hub, { force: false, forceSkill: false });
    const item = staged.installs[0]!;
    // Simulate destination appearing between Phase 1 and Phase 2 -> fresh install throws!
    mkdirSync(item.dstDir, { recursive: true });
    const paths = getStatePaths(hub, home, join(home, ".local", "state"));
    expect(() =>
      applySkillInstall(item, hub, createEmptyState(hub), paths.journalPath, {
        adopt: false,
        force: false,
        forceSkill: false,
      }),
    ).toThrow(/stale snapshot/);

    const leftovers = readdirSync(join(hub, "skills")).filter((n) => n.startsWith(".staging-"));
    expect(leftovers).toEqual([]);
  });

  test("F5: corrupt mcpServers (null / array) in JSON target fails closed without clobbering", () => {
    const { home, hub, env } = makeSandbox();
    mkdirSync(join(hub, "mcp", "demo"), { recursive: true });
    writeFileSync(
      join(hub, "mcp", "demo", "mcp.json"),
      JSON.stringify({ mcp: { command: "/bin/demo" } }),
    );

    // mcpServers: null
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: null }, null, 2) + "\n");
    const rNull = runCmd([SYNC_BIN], env);
    expect(rNull.exitCode).toBe(1);
    expect(rNull.stderr).toContain('"mcpServers" must be a JSON object (found null)');
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers).toBeNull();

    // mcpServers: []
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: [] }, null, 2) + "\n");
    const rArr = runCmd([SYNC_BIN], env);
    expect(rArr.exitCode).toBe(1);
    expect(rArr.stderr).toContain('"mcpServers" must be a JSON object (found array)');
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers).toEqual([]);
  });

  test("F6: corrupt/truncated state and journal files fail closed with schema validation errors", () => {
    const { home, hub, env } = makeSandbox();
    const paths = getStatePaths(hub, home, env.XDG_STATE_HOME);
    mkdirSync(paths.stateDir, { recursive: true });

    // Missing required fields in links record -> must NOT coerce to "undefined"
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        version: 2,
        generation: 1,
        hubPath: hub,
        links: { "/tmp/bad": { kind: "rules" } },
        mcp: {},
        resolvedLegacyV1: {},
      }),
    );
    expect(() => loadOwnershipState(paths.statePath, hub)).toThrow(/missing or invalid link target/);

    rmSync(paths.statePath);

    // Truncated journal missing before/after/destination/stateDelta
    writeFileSync(paths.journalPath, JSON.stringify({ version: 1, opId: "trunc" }));
    expect(() => loadPendingJournal(paths.journalPath)).toThrow(/corrupt pending recovery journal/);
  });

  test("F7 & F8 & F13: install.sh relative shim resolution, missing-arg exit 2, --opt=val, and atomic swap", () => {
    const { home, env } = makeSandbox();
    const prefix = join(home, ".agent-hub");
    const binDir = join(home, ".local", "bin");

    // Missing arg exits 2 cleanly (no bash unbound variable!)
    const rMissing = runCmd([INSTALL_SH, "--prefix"], env);
    expect(rMissing.exitCode).toBe(2);
    expect(rMissing.stderr).toContain("--prefix requires an argument");
    expect(rMissing.stderr).not.toContain("unbound variable");

    // bin/sync-agents --print-dir --dir (missing arg) exits 2 cleanly
    const rPrintMissing = runCmd([SYNC_BIN, "--print-dir", "--dir"], env);
    expect(rPrintMissing.exitCode).toBe(2);
    expect(rPrintMissing.stderr).toContain("--dir requires a path argument");

    // --prefix=... and --bin-dir=... syntax works
    const rEq = runCmd([INSTALL_SH, `--prefix=${prefix}`, `--bin-dir=${binDir}`, "--no-skill"], env);
    expect(rEq.exitCode).toBe(0);

    // Replace shim with a relative symlink and re-run install.sh from an unrelated CWD
    rmSync(join(binDir, "sync-agents"));
    symlinkSync("../../.agent-hub/bin/sync-agents", join(binDir, "sync-agents"));
    const otherCwd = join(home, "elsewhere");
    mkdirSync(otherCwd, { recursive: true });
    const rRel = runCmd([INSTALL_SH, "--prefix", prefix, "--bin-dir", binDir, "--no-skill"], env, otherCwd);
    expect(rRel.exitCode).toBe(0);
    expect(readlinkSync(join(binDir, "sync-agents"))).toBe(join(prefix, "bin", "sync-agents"));
  }, INSTALLER_TIMEOUT_MS);

  test("F9: --adopt --skill <src> installs and adopts identical existing target copy in a single pass", () => {
    const { home, hub, env } = makeSandbox();
    const src = join(home, "src-onepass");
    const dst = join(home, ".claude", "skills", "onepass");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: onepass\n---\n# One Pass\n");
    writeFileSync(join(dst, "SKILL.md"), "---\nname: onepass\n---\n# One Pass\n");
    chmodSync(join(src, "SKILL.md"), 0o644);
    chmodSync(join(dst, "SKILL.md"), 0o644);
    chmodSync(src, 0o755);
    chmodSync(dst, 0o755);

    const res = runCmd([SYNC_BIN, "--adopt", "--skill", src], env);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(hub, "skills", "onepass", "SKILL.md"))).toBe(true);
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dst)).toBe(join(hub, "skills", "onepass"));
    expect(runCmd([SYNC_BIN, "--check"], env).exitCode).toBe(0);
  });

  test("F10: YAML frontmatter name parses inline comments and quoted scalars cleanly", () => {
    expect(parseYamlScalar("demo-skill # inline comment")).toBe("demo-skill");
    expect(parseYamlScalar('"demo-skill" # quoted comment')).toBe("demo-skill");
    expect(parseYamlScalar("'demo-skill' # single quoted")).toBe("demo-skill");
    expect(parseYamlScalar("plain-name")).toBe("plain-name");

    const { home, hub, env } = makeSandbox();
    const src = join(home, "src-yaml");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: yaml-comment # trailing comment\n---\n# Ok\n");
    const res = runCmd([SYNC_BIN, "--skill", src], env);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(hub, "skills", "yaml-comment", "SKILL.md"))).toBe(true);
  });

  test("F11: local skill source filename starting with '-' is not parsed as a CLI flag", () => {
    const { home, hub, env } = makeSandbox();
    const inner = join(home, "dash-src");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "SKILL.md"), "---\nname: dash-skill\n---\n# Dash\n");
    const dashTar = join(home, "--upload-pack=evil.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", dashTar, "-C", home, "dash-src"]).exitCode).toBe(0);

    // Invoke with relative filename starting with "--"
    const res = runCmd([SYNC_BIN, "--skill", "--upload-pack=evil.tar.gz"], env, home);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(hub, "skills", "dash-skill", "SKILL.md"))).toBe(true);
  });

  test("F14: malformed JSON errors include the offending file path", () => {
    const { home, hub, env } = makeSandbox();
    const badMcp = join(hub, "mcp", "broken", "mcp.json");
    mkdirSync(join(hub, "mcp", "broken"), { recursive: true });
    writeFileSync(badMcp, "{ bad json");
    const r1 = runCmd([SYNC_BIN], env);
    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).toContain(badMcp);
    rmSync(join(hub, "mcp", "broken"), { recursive: true, force: true });

    const claudePath = join(home, ".claude.json");
    writeFileSync(claudePath, "{ bad claude json");
    const r2 = runCmd([SYNC_BIN], env);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain(claudePath);
  });

  test("F15 & F16: native FFI xattr/ACL reads 100-file tree fast (zero subprocesses) and classifies Linux ENOTSUP safely", () => {
    // Verify Linux ENOTSUP / ENODATA classification
    expect(classifyLinuxXattrErrno(95)).toBe("unsupported");
    expect(classifyLinuxXattrErrno(61)).toBe("empty");
    expect(classifyLinuxXattrErrno(34)).toBe("retry");
    expect(classifyLinuxXattrErrno(13)).toBe("error");

    const { home } = makeSandbox();
    const bigSkill = join(home, "big-skill");
    mkdirSync(bigSkill, { recursive: true });
    for (let i = 0; i < 100; i += 1) {
      writeFileSync(join(bigSkill, `file-${i}.txt`), `content-${i}\n`);
    }

    const t0 = performance.now();
    const rec = computeEquivalenceRecord(bigSkill);
    const elapsedMs = performance.now() - t0;
    expect(rec.ok).toBe(true);
    // Native FFI should scan 100 files well under 500ms (previously ~2,500ms+ with 200+ forks).
    expect(elapsedMs).toBeLessThan(500);

    if (process.platform === "darwin") {
      const f = join(bigSkill, "file-0.txt");
      expect(Bun.spawnSync(["/usr/bin/xattr", "-w", "test.attr", "A", f]).exitCode).toBe(0);
      const m = readEntryMetadata(f, false);
      expect(m.ok).toBe(true);
      if (m.ok) {
        expect(m.xattrVerified).toBe(true);
        expect(m.xattrs["test.attr"]).toBe("41"); // hex('A')
      }
    }
  });

  test("F17 & F18c: CRLF preservation and TOML 1.0/1.1 \\e, \\xHH, \\uXXXX, \\UXXXXXXXX basic-string key escapes", () => {
    const crlfOrig = 'model = "gpt-5"\r\n\r\n[mcp_servers.demo]\r\ncommand = "/old"\r\n';
    const crlfOut = rewriteCodexToml(crlfOrig, new Map([["demo", { command: "/new" }]]));
    expect(crlfOut).toContain("\r\n");
    expect(crlfOut.replace(/\r\n/g, "")).not.toContain("\n");

    expect(decodeTomlBasicString('"foo\\U0001F600"')).toBe("foo😀");
    expect(decodeTomlBasicString('"bar\\e\\x41"')).toBe("bar\u001bA");
    expect(decodeTomlBasicString('"bad\\uD800"')).toBeNull(); // surrogate rejected

    const doc =
      '[mcp_servers."foo\\U0001F600"]\ncommand = "/bin/a"\n\n[mcp_servers."bar\\e"]\ncommand = "/bin/b"\n';
    const scan = scanTomlDocument(doc);
    expect(scan.sections[0]?.headerPath).toEqual(["mcp_servers", "foo😀"]);
    expect(scan.sections[1]?.headerPath).toEqual(["mcp_servers", "bar\u001b"]);
  });
});
