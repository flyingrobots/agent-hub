import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { readEntryMetadata, type EntryMetadataResult } from "./metadata.ts";
import type { TargetSnapshot } from "./types.ts";

export { readEntryMetadata, type EntryMetadataResult };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Parse a JSON file with the offending file path included in SyntaxError diagnostics.
 */
export function parseJsonFile(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${filePath}: invalid JSON: ${msg}`);
  }
}

/**
 * Parse a target agent JSON config file strictly via JSON.parse (never scanning raw
 * text for `//`, which false-positives on https:// URLs). On SyntaxError, explicitly
 * notes that JSONC comments and trailing commas are unsupported until a comment-preserving
 * editor is added.
 */
export function parseStrictJsonTargetFile(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${filePath}: invalid JSON (${msg}). Strict JSON is required; JSONC comments and trailing commas are unsupported until a comment-preserving editor is added`,
    );
  }
  // JSON.parse keeps only the last of duplicate keys; rewriting the file would then silently
  // drop the earlier value (for example a user's own block of MCP servers). Refuse instead.
  const dup = findDuplicateJsonKey(raw);
  if (dup) {
    throw new Error(
      `${filePath}: duplicate key "${dup.key}" at ${dup.path}; JSON.parse would keep only the last value and a rewrite would silently drop the others. Merge the duplicates by hand first`,
    );
  }
  return parsed;
}

/**
 * Find the first object key that appears twice in the same object of a document that
 * JSON.parse has already accepted. Keys are compared after decoding escapes, so "a" and
 * "\u0061" collide. Returns the decoded key and a JSONPath-like location, or null.
 */
export function findDuplicateJsonKey(text: string): { key: string; path: string } | null {
  type Frame = { kind: "object"; keys: Set<string>; path: string; pendingKey: string | null } | { kind: "array"; path: string; index: number };
  const stack: Frame[] = [];
  const childPath = (): string => {
    const top = stack[stack.length - 1];
    if (!top) return "$";
    if (top.kind === "array") return `${top.path}[${top.index}]`;
    return `${top.path}.${top.pendingKey ?? "?"}`;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const literal = text.slice(i, j + 1);
      i = j + 1;
      const top = stack[stack.length - 1];
      if (top?.kind === "object" && top.pendingKey === null) {
        let k = i;
        while (k < n && /\s/.test(text[k]!)) k++;
        if (text[k] === ":") {
          const key = JSON.parse(literal) as string;
          if (top.keys.has(key)) return { key, path: top.path };
          top.keys.add(key);
          top.pendingKey = key;
          i = k + 1;
        }
      }
      continue;
    }
    if (ch === "{" || ch === "[") {
      const path = childPath();
      stack.push(ch === "{" ? { kind: "object", keys: new Set(), path, pendingKey: null } : { kind: "array", path, index: 0 });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") top.pendingKey = null;
      else if (top?.kind === "array") top.index++;
    }
    i++;
  }
  return null;
}

/**
 * The physical identity of a destination path: its parent directory resolved through symlinks
 * (deepest existing ancestor), joined with its own name, which is not resolved, because the
 * destination itself may be a symlink that sync-agents manages. Two spellings of one location
 * (a symlinked ~/.config, an aliased HOME) have the same physical path.
 */
export function physicalPath(p: string): string {
  const parent = dirname(p);
  if (parent === p) return p;
  return join(canonicalizeHubPath(parent, "/", "/"), p.slice(parent.length === 1 ? 1 : parent.length + 1));
}

export function expandTilde(rawPath: string, homeDir: string): string {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/")) return join(homeDir, rawPath.slice(2));
  return rawPath;
}

/**
 * Normalize a hub path (expanding ~, resolving relative paths against cwd, and
 * resolving the deepest existing ancestor via realpathSync) so relative paths
 * and macOS /tmp vs /private/tmp always produce one canonical absolute path.
 */
export function canonicalizeHubPath(rawPath: string, homeDir: string, cwd: string): string {
  const expanded = expandTilde(rawPath, homeDir);
  const abs = isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);

  const tail: string[] = [];
  let cursor = abs;
  while (true) {
    if (existsSync(cursor)) {
      const realBase = realpathSync(cursor);
      const joined = tail.length > 0 ? join(realBase, ...tail.reverse()) : realBase;
      return joined.length > 1 && joined.endsWith(sep) ? joined.slice(0, -1) : joined;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
    }
    const base = cursor.slice(parent.length === 1 ? 1 : parent.length + 1);
    if (base.length > 0) tail.push(base);
    cursor = parent;
  }
}

/**
 * Predict the uid/gid a newly created file or symlink will receive inside `parentDir`,
 * accounting for BSD/macOS and setgid-directory GID inheritance.
 */
export function predictNewEntryOwner(parentDir: string): { uid: number; gid: number } {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const procGid = typeof process.getgid === "function" ? process.getgid() : 0;
  try {
    let cursor = parentDir;
    while (!existsSync(cursor)) {
      const next = dirname(cursor);
      if (next === cursor) return { uid, gid: procGid };
      cursor = next;
    }
    const st = statSync(cursor);
    if (process.platform === "darwin" || (st.mode & 0o2000) !== 0) {
      return { uid, gid: st.gid };
    }
  } catch {
    // fallback to process gid
  }
  return { uid, gid: procGid };
}

/**
 * Best-effort POSIX directory fsync. Propagates real I/O errors while ignoring
 * EINVAL/EROFS/EBADF on filesystems that do not support directory fsync.
 */
export function fsyncDir(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EINVAL" || code === "EROFS" || code === "EPERM" || code === "EBADF") {
      return;
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Atomic file replacement using temp file + chmod + fsync + rename + fsyncDir.
 */
export function atomicWriteDurable(
  filePath: string,
  content: string | Uint8Array,
  fallbackMode = 0o644,
  explicitMode?: number,
): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const mode =
    explicitMode !== undefined
      ? explicitMode & 0o7777
      : existsSync(filePath)
        ? statSync(filePath).mode & 0o7777
        : fallbackMode & 0o7777;

  const tmpPath = join(
    dir,
    `.sync-agents-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`,
  );

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, filePath);
    fsyncDir(dir);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function snapshotsEqual(a: TargetSnapshot, b: TargetSnapshot): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "absent":
      return true;
    case "file": {
      const bf = b as Extract<TargetSnapshot, { kind: "file" }>;
      return a.sha256 === bf.sha256 && a.mode === bf.mode && a.uid === bf.uid && a.gid === bf.gid;
    }
    case "symlink": {
      const bs = b as Extract<TargetSnapshot, { kind: "symlink" }>;
      return a.target === bs.target && a.uid === bs.uid && a.gid === bs.gid;
    }
    case "tree": {
      const bt = b as Extract<TargetSnapshot, { kind: "tree" }>;
      return a.rootKind === bt.rootKind && a.equivalenceDigest === bt.equivalenceDigest;
    }
  }
}

export function captureFileSnapshot(filePath: string): TargetSnapshot {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
  if (!st.isFile()) {
    if (st.isSymbolicLink()) {
      return {
        kind: "symlink",
        target: readlinkSync(filePath),
        uid: st.uid,
        gid: st.gid,
      };
    }
    const tree = computeEquivalenceRecord(filePath);
    if (!tree.ok) {
      throw new Error(`cannot snapshot ${filePath}: ${tree.reason}`);
    }
    return {
      kind: "tree",
      rootKind: tree.rootKind,
      equivalenceDigest: tree.digest,
    };
  }
  const bytes = readFileSync(filePath);
  return {
    kind: "file",
    sha256: sha256Hex(bytes),
    mode: st.mode & 0o7777,
    uid: st.uid,
    gid: st.gid,
  };
}

export function captureSymlinkOrAbsentSnapshot(destPath: string): TargetSnapshot {
  let st;
  try {
    st = lstatSync(destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: readlinkSync(destPath),
      uid: st.uid,
      gid: st.gid,
    };
  }
  if (st.isFile()) {
    const bytes = readFileSync(destPath);
    return {
      kind: "file",
      sha256: sha256Hex(bytes),
      mode: st.mode & 0o7777,
      uid: st.uid,
      gid: st.gid,
    };
  }
  const tree = computeEquivalenceRecord(destPath);
  if (!tree.ok) {
    return { kind: "tree", rootKind: "dir", equivalenceDigest: `unreadable:${tree.reason}` };
  }
  return {
    kind: "tree",
    rootKind: tree.rootKind,
    equivalenceDigest: tree.digest,
  };
}

export function captureTreeSnapshot(targetPath: string): TargetSnapshot {
  let st;
  try {
    st = lstatSync(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: readlinkSync(targetPath),
      uid: st.uid,
      gid: st.gid,
    };
  }
  const rec = computeEquivalenceRecord(targetPath);
  if (!rec.ok) {
    throw new Error(`cannot snapshot tree ${targetPath}: ${rec.reason}`);
  }
  return {
    kind: "tree",
    rootKind: rec.rootKind,
    equivalenceDigest: rec.digest,
  };
}

export type TreeEntryRecord = {
  relPath: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  uid: number;
  gid: number;
  hardlinked: boolean;
  sha256?: string;
  symlinkTarget?: string;
  escapesRoot?: boolean;
  xattrs: Record<string, string>;
  acls: string[];
};

export type EquivalenceRecordResult =
  | {
      ok: true;
      rootKind: "file" | "dir";
      entries: TreeEntryRecord[];
      digest: string;
    }
  | { ok: false; reason: string };

/**
 * Compute a deterministic, full-tree equivalence record covering:
 * - all entries (including .git, hidden dotfiles, empty subdirectories)
 * - file kinds (refusing FIFOs, sockets, device nodes)
 * - regular file bytes, full mode & 0o7777, uid, gid, hardlink status
 * - symlink targets and escaping-relative-symlink detection
 * - extended attribute names + raw hex values and ACL lines (via native FFI)
 */
export function computeEquivalenceRecord(
  rootPath: string,
  opts?: { excludeRootGit?: boolean; forceRootDirMode?: number },
): EquivalenceRecordResult {
  let rootStat;
  try {
    rootStat = lstatSync(rootPath);
  } catch (err) {
    return {
      ok: false,
      reason: `cannot stat ${rootPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!rootStat.isFile() && !rootStat.isDirectory()) {
    return { ok: false, reason: `unsupported object kind at ${rootPath}` };
  }
  const rootKind: "file" | "dir" = rootStat.isFile() ? "file" : "dir";
  const absRoot = resolve(rootPath);
  const entries: TreeEntryRecord[] = [];

  const visit = (absPath: string, relPath: string): string | null => {
    let st;
    try {
      st = lstatSync(absPath);
    } catch (err) {
      return `cannot lstat ${relPath || "."}: ${err instanceof Error ? err.message : String(err)}`;
    }

    const isFile = st.isFile();
    const isDir = st.isDirectory();
    const isSymlink = st.isSymbolicLink();
    if (!isFile && !isDir && !isSymlink) {
      return `unsupported filesystem object kind at ${relPath || "."}`;
    }

    const meta = readEntryMetadata(absPath, isSymlink);
    if (!meta.ok) return meta.reason;

    if (isFile) {
      const bytes = readFileSync(absPath);
      entries.push({
        relPath,
        kind: "file",
        mode: st.mode & 0o7777,
        uid: st.uid,
        gid: st.gid,
        hardlinked: st.nlink > 1,
        sha256: sha256Hex(bytes),
        xattrs: meta.xattrs,
        acls: meta.acls,
      });
      return null;
    }

    if (isSymlink) {
      const target = readlinkSync(absPath);
      let escapesRoot = false;
      if (!isAbsolute(target)) {
        const resolvedTarget = resolve(dirname(absPath), target);
        const rel = relative(absRoot, resolvedTarget);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          escapesRoot = true;
        }
      }
      entries.push({
        relPath,
        kind: "symlink",
        mode: st.mode & 0o7777,
        uid: st.uid,
        gid: st.gid,
        hardlinked: false,
        symlinkTarget: target,
        escapesRoot,
        xattrs: meta.xattrs,
        acls: meta.acls,
      });
      return null;
    }

    const effectiveMode =
      relPath === "" && opts?.forceRootDirMode !== undefined
        ? opts.forceRootDirMode & 0o7777
        : st.mode & 0o7777;

    entries.push({
      relPath,
      kind: "dir",
      mode: effectiveMode,
      uid: st.uid,
      gid: st.gid,
      hardlinked: false,
      xattrs: meta.xattrs,
      acls: meta.acls,
    });

    const children = readdirSync(absPath).sort();
    for (const child of children) {
      if (opts?.excludeRootGit && relPath === "" && child === ".git") {
        continue;
      }
      const childRel = relPath ? `${relPath}/${child}` : child;
      const err = visit(join(absPath, child), childRel);
      if (err) return err;
    }
    return null;
  };

  const err = visit(absRoot, "");
  if (err) return { ok: false, reason: err };

  const digest = sha256Hex(stableJson({ rootKind, entries }));
  return { ok: true, rootKind, entries, digest };
}

export type AdoptionEquivalenceResult =
  | {
      equivalent: true;
      srcSnapshot: Extract<TargetSnapshot, { kind: "tree" }>;
      dstSnapshot: Extract<TargetSnapshot, { kind: "tree" }>;
    }
  | { equivalent: false; reason: string };

/**
 * Finite, explicit adoption-equivalence contract comparing canonical `src`
 * against existing non-symlink `dst`. Refuses any difference in entry set
 * (including .git), file kind, bytes, mode & 0o7777, uid/gid, hardlinks,
 * escaping relative symlinks, xattr names/raw values, or ACL lines.
 */
export function checkAdoptionEquivalence(
  src: string,
  dst: string,
  srcOpts?: { excludeRootGit?: boolean; forceRootDirMode?: number },
): AdoptionEquivalenceResult {
  const srcRec = computeEquivalenceRecord(src, srcOpts);
  if (!srcRec.ok) {
    return { equivalent: false, reason: `canonical source check failed: ${srcRec.reason}` };
  }
  const dstRec = computeEquivalenceRecord(dst);
  if (!dstRec.ok) {
    return { equivalent: false, reason: `destination check failed: ${dstRec.reason}` };
  }

  if (srcRec.rootKind !== dstRec.rootKind) {
    return {
      equivalent: false,
      reason: `kind differs (destination is ${dstRec.rootKind}, canonical source is ${srcRec.rootKind})`,
    };
  }

  for (const entry of dstRec.entries) {
    const label = entry.relPath || ".";
    if (entry.kind === "file" && entry.hardlinked) {
      return {
        equivalent: false,
        reason: `destination contains hardlinked file "${label}" (replacing would sever hardlink identity)`,
      };
    }
    if (entry.kind === "symlink" && entry.escapesRoot) {
      return {
        equivalent: false,
        reason: `destination contains escaping relative symlink "${label}" -> "${entry.symlinkTarget}"`,
      };
    }
  }

  const srcMap = new Map(srcRec.entries.map((e) => [e.relPath, e]));
  const dstMap = new Map(dstRec.entries.map((e) => [e.relPath, e]));

  for (const [rel, dstEntry] of dstMap) {
    const srcEntry = srcMap.get(rel);
    const label = rel || ".";
    if (!srcEntry) {
      return {
        equivalent: false,
        reason: `destination has extra entry "${label}" not present in canonical source`,
      };
    }
    if (srcEntry.kind !== dstEntry.kind) {
      return {
        equivalent: false,
        reason: `entry "${label}" kind differs (destination ${dstEntry.kind} vs source ${srcEntry.kind})`,
      };
    }
    if (srcEntry.mode !== dstEntry.mode) {
      return {
        equivalent: false,
        reason: `entry "${label}" mode differs (destination 0${dstEntry.mode.toString(8)} vs source 0${srcEntry.mode.toString(8)})`,
      };
    }
    if (srcEntry.uid !== dstEntry.uid || srcEntry.gid !== dstEntry.gid) {
      return {
        equivalent: false,
        reason: `entry "${label}" owner/group differs (destination ${dstEntry.uid}:${dstEntry.gid} vs source ${srcEntry.uid}:${srcEntry.gid})`,
      };
    }
    if (srcEntry.kind === "file" && srcEntry.sha256 !== dstEntry.sha256) {
      return {
        equivalent: false,
        reason: `file "${label}" contents differ`,
      };
    }
    if (srcEntry.kind === "symlink" && srcEntry.symlinkTarget !== dstEntry.symlinkTarget) {
      return {
        equivalent: false,
        reason: `symlink "${label}" target differs (destination "${dstEntry.symlinkTarget}" vs source "${srcEntry.symlinkTarget}")`,
      };
    }
    if (stableJson(srcEntry.xattrs) !== stableJson(dstEntry.xattrs)) {
      return {
        equivalent: false,
        reason: `entry "${label}" extended attributes differ`,
      };
    }
    if (stableJson(srcEntry.acls) !== stableJson(dstEntry.acls)) {
      return {
        equivalent: false,
        reason: `entry "${label}" ACLs differ`,
      };
    }
  }

  for (const rel of srcMap.keys()) {
    if (!dstMap.has(rel)) {
      return {
        equivalent: false,
        reason: `canonical source has entry "${rel || "."}" missing from destination`,
      };
    }
  }

  return {
    equivalent: true,
    srcSnapshot: {
      kind: "tree",
      rootKind: srcRec.rootKind,
      equivalenceDigest: srcRec.digest,
    },
    dstSnapshot: {
      kind: "tree",
      rootKind: dstRec.rootKind,
      equivalenceDigest: dstRec.digest,
    },
  };
}
