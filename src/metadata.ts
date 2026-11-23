/**
 * Native FFI extended-attribute and ACL metadata inspection (zero subprocesses on macOS,
 * native llistxattr/lgetxattr with ENOTSUP handling on Linux).
 *
 * Isolates all bun:ffi xattr/ACL syscall bindings cleanly alongside src/lock.ts.
 */
import { CString, dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";

export type EntryMetadataResult =
  | {
      ok: true;
      xattrs: Record<string, string>; // attrName -> lowercase hex raw bytes
      acls: string[];
      xattrVerified: boolean;
      aclVerified: boolean;
    }
  | { ok: false; reason: string };

const DARWIN_XATTR_NOFOLLOW = 0x0001;
/**
 * Extended attributes left out of every metadata read. `com.apple.provenance` is macOS's own
 * record of which application wrote a file: it says nothing about the file's content, and it
 * differs between two identical copies written by different programs, sync-agents included.
 */
const DARWIN_IGNORED_XATTRS: ReadonlySet<string> = new Set(["com.apple.provenance"]);
const DARWIN_ACL_TYPE_EXTENDED = 0x00000100;
const DARWIN_ENOENT = 2;
const DARWIN_ENOTSUP = 45;
const DARWIN_EOPNOTSUPP = 102;
const DARWIN_ENOATTR = 93;

const LINUX_ENODATA = 61;
const LINUX_EOPNOTSUPP = 95;
const LINUX_ERANGE = 34;

type DarwinBindings = {
  listxattr: (path: Pointer, namebuf: Pointer | null, size: bigint, options: number) => bigint;
  getxattr: (
    path: Pointer,
    name: Pointer,
    value: Pointer | null,
    size: bigint,
    position: number,
    options: number,
  ) => bigint;
  acl_get_link_np: (path: Pointer, type: number) => Pointer | null;
  acl_to_text: (acl: Pointer, lenP: Pointer | null) => Pointer | null;
  acl_free: (obj: Pointer) => number;
  getErrno: () => number;
};

type LinuxBindings = {
  llistxattr: (path: Pointer, list: Pointer | null, size: bigint) => bigint;
  lgetxattr: (path: Pointer, name: Pointer, value: Pointer | null, size: bigint) => bigint;
  getErrno: () => number;
};

let darwinBindings: DarwinBindings | null = null;
let linuxBindings: LinuxBindings | null | undefined = undefined;
let cachedGetfaclPath: string | null | undefined = undefined;

function getDarwinBindings(): DarwinBindings {
  if (darwinBindings) return darwinBindings;
  const lib = dlopen("libSystem.B.dylib", {
    listxattr: {
      args: [FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.i32],
      returns: FFIType.i64,
    },
    getxattr: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.ptr,
        FFIType.u64,
        FFIType.u32,
        FFIType.i32,
      ],
      returns: FFIType.i64,
    },
    acl_get_link_np: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.ptr },
    acl_to_text: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });

  darwinBindings = {
    listxattr: (p, buf, size, opts) =>
      BigInt(lib.symbols.listxattr(p, buf, size, opts) as bigint | number),
    getxattr: (p, name, buf, size, pos, opts) =>
      BigInt(lib.symbols.getxattr(p, name, buf, size, pos, opts) as bigint | number),
    acl_get_link_np: (p, type) => lib.symbols.acl_get_link_np(p, type) as Pointer | null,
    acl_to_text: (acl, lenP) => lib.symbols.acl_to_text(acl, lenP) as Pointer | null,
    acl_free: (obj) => lib.symbols.acl_free(obj),
    getErrno: () => {
      const p = lib.symbols.__error() as Pointer | null;
      return p ? read.i32(p, 0) : 0;
    },
  };
  return darwinBindings;
}

function getLinuxBindings(): LinuxBindings | null {
  if (linuxBindings !== undefined) return linuxBindings;
  const candidates = ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];
  for (const libName of candidates) {
    try {
      const lib = dlopen(libName, {
        llistxattr: { args: [FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
        lgetxattr: {
          args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64],
          returns: FFIType.i64,
        },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      linuxBindings = {
        llistxattr: (p, buf, size) => BigInt(lib.symbols.llistxattr(p, buf, size) as bigint | number),
        lgetxattr: (p, name, buf, size) =>
          BigInt(lib.symbols.lgetxattr(p, name, buf, size) as bigint | number),
        getErrno: () => {
          const p = lib.symbols.__errno_location() as Pointer | null;
          return p ? read.i32(p, 0) : 0;
        },
      };
      return linuxBindings;
    } catch {
      // try next candidate
    }
  }
  linuxBindings = null;
  return null;
}

function findGetfacl(): string | null {
  if (cachedGetfaclPath !== undefined) return cachedGetfaclPath;
  const res = Bun.spawnSync(["which", "getfacl"], { stdout: "pipe", stderr: "pipe" });
  const out = res.exitCode === 0 ? res.stdout.toString("utf8").trim() : "";
  cachedGetfaclPath = out.length > 0 ? out : null;
  return cachedGetfaclPath;
}

function toCStringBuffer(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf8");
}

function splitNulTerminatedNames(buf: Uint8Array, byteLen: number): string[] {
  const names: string[] = [];
  let start = 0;
  for (let i = 0; i < byteLen; i += 1) {
    if (buf[i] === 0) {
      if (i > start) {
        names.push(Buffer.from(buf.subarray(start, i)).toString("utf8"));
      }
      start = i + 1;
    }
  }
  return names.sort();
}

/**
 * Classify Linux xattr syscall errno cleanly so xattr-less filesystems
 * (tmpfs without CONFIG_TMPFS_XATTR, vfat, FUSE/overlayfs) degrade to
 * `xattrVerified: false` instead of crashing skill installs/adoptions.
 */
export function classifyLinuxXattrErrno(
  errno: number,
): "unsupported" | "empty" | "retry" | "error" {
  if (errno === LINUX_EOPNOTSUPP) return "unsupported";
  if (errno === LINUX_ENODATA) return "empty";
  if (errno === LINUX_ERANGE) return "retry";
  return "error";
}

function readDarwinMetadata(entryPath: string): EntryMetadataResult {
  const api = getDarwinBindings();
  const pathBuf = toCStringBuffer(entryPath);
  const pathPtr = ptr(pathBuf);

  // 1. Extended attributes via listxattr(2) + getxattr(2) with XATTR_NOFOLLOW
  const xattrs: Record<string, string> = {};
  let xattrVerified = true;

  const listSize = api.listxattr(pathPtr, null, 0n, DARWIN_XATTR_NOFOLLOW);
  if (listSize < 0n) {
    const errno = api.getErrno();
    if (errno === DARWIN_ENOTSUP || errno === DARWIN_EOPNOTSUPP) {
      xattrVerified = false;
    } else {
      return { ok: false, reason: `listxattr failed for ${entryPath} (errno=${errno})` };
    }
  } else if (listSize > 0n) {
    const listBuf = new Uint8Array(Number(listSize));
    const readBytes = api.listxattr(pathPtr, ptr(listBuf), listSize, DARWIN_XATTR_NOFOLLOW);
    if (readBytes < 0n) {
      const errno = api.getErrno();
      return { ok: false, reason: `listxattr read failed for ${entryPath} (errno=${errno})` };
    }
    const names = splitNulTerminatedNames(listBuf, Number(readBytes));
    for (const name of names) {
      if (DARWIN_IGNORED_XATTRS.has(name)) continue;
      const nameBuf = toCStringBuffer(name);
      const namePtr = ptr(nameBuf);
      const valSize = api.getxattr(pathPtr, namePtr, null, 0n, 0, DARWIN_XATTR_NOFOLLOW);
      if (valSize < 0n) {
        const errno = api.getErrno();
        if (errno === DARWIN_ENOATTR) continue;
        return {
          ok: false,
          reason: `getxattr size failed for "${name}" on ${entryPath} (errno=${errno})`,
        };
      }
      if (valSize === 0n) {
        xattrs[name] = "";
        continue;
      }
      const valBuf = new Uint8Array(Number(valSize));
      const got = api.getxattr(pathPtr, namePtr, ptr(valBuf), valSize, 0, DARWIN_XATTR_NOFOLLOW);
      if (got < 0n) {
        const errno = api.getErrno();
        return {
          ok: false,
          reason: `getxattr read failed for "${name}" on ${entryPath} (errno=${errno})`,
        };
      }
      xattrs[name] = Buffer.from(valBuf.subarray(0, Number(got))).toString("hex");
    }
  }

  // 2. Extended ACLs via acl_get_link_np(ACL_TYPE_EXTENDED) — zero subprocesses!
  const acls: string[] = [];
  let aclVerified = true;
  const aclPtr = api.acl_get_link_np(pathPtr, DARWIN_ACL_TYPE_EXTENDED);
  if (!aclPtr) {
    const errno = api.getErrno();
    if (errno === DARWIN_ENOTSUP || errno === DARWIN_EOPNOTSUPP) {
      aclVerified = false;
    } else if (errno !== 0 && errno !== DARWIN_ENOENT) {
      return { ok: false, reason: `acl_get_link_np failed for ${entryPath} (errno=${errno})` };
    }
  } else {
    try {
      const textPtr = api.acl_to_text(aclPtr, null);
      if (!textPtr) {
        return { ok: false, reason: `acl_to_text failed for ${entryPath}` };
      }
      try {
        const text = new CString(textPtr).toString();
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.length > 0 && !trimmed.startsWith("!#acl")) {
            acls.push(trimmed);
          }
        }
      } finally {
        api.acl_free(textPtr);
      }
    } finally {
      api.acl_free(aclPtr);
    }
  }

  return { ok: true, xattrs, acls, xattrVerified, aclVerified };
}

function readLinuxMetadata(entryPath: string, isSymlink: boolean): EntryMetadataResult {
  const xattrs: Record<string, string> = {};
  let xattrVerified = false;

  const api = getLinuxBindings();
  if (api) {
    const pathBuf = toCStringBuffer(entryPath);
    const pathPtr = ptr(pathBuf);
    const listSize = api.llistxattr(pathPtr, null, 0n);

    if (listSize < 0n) {
      const errno = api.getErrno();
      const kind = classifyLinuxXattrErrno(errno);
      if (kind === "unsupported") {
        xattrVerified = false;
      } else if (kind === "empty") {
        xattrVerified = true;
      } else {
        return { ok: false, reason: `llistxattr failed for ${entryPath} (errno=${errno})` };
      }
    } else {
      xattrVerified = true;
      if (listSize > 0n) {
        const listBuf = new Uint8Array(Number(listSize));
        const readBytes = api.llistxattr(pathPtr, ptr(listBuf), listSize);
        if (readBytes < 0n) {
          const errno = api.getErrno();
          const kind = classifyLinuxXattrErrno(errno);
          if (kind === "unsupported") {
            xattrVerified = false;
          } else {
            return { ok: false, reason: `llistxattr read failed for ${entryPath} (errno=${errno})` };
          }
        } else {
          const names = splitNulTerminatedNames(listBuf, Number(readBytes));
          for (const name of names) {
            const nameBuf = toCStringBuffer(name);
            const namePtr = ptr(nameBuf);
            const valSize = api.lgetxattr(pathPtr, namePtr, null, 0n);
            if (valSize < 0n) {
              const errno = api.getErrno();
              const kind = classifyLinuxXattrErrno(errno);
              if (kind === "empty") continue;
              if (kind === "unsupported") {
                xattrVerified = false;
                break;
              }
              return {
                ok: false,
                reason: `lgetxattr size failed for "${name}" on ${entryPath} (errno=${errno})`,
              };
            }
            if (valSize === 0n) {
              xattrs[name] = "";
              continue;
            }
            const valBuf = new Uint8Array(Number(valSize));
            const got = api.lgetxattr(pathPtr, namePtr, ptr(valBuf), valSize);
            if (got < 0n) {
              const errno = api.getErrno();
              return {
                ok: false,
                reason: `lgetxattr read failed for "${name}" on ${entryPath} (errno=${errno})`,
              };
            }
            xattrs[name] = Buffer.from(valBuf.subarray(0, Number(got))).toString("hex");
          }
        }
      }
    }
  }

  const acls: string[] = [];
  let aclVerified = false;
  const getfacl = findGetfacl();
  if (getfacl && !isSymlink) {
    const res = Bun.spawnSync([getfacl, "-p", "--omit-header", "--numeric", entryPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode === 0) {
      for (const line of res.stdout.toString("utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) acls.push(trimmed);
      }
      aclVerified = true;
    } else {
      const stderrText = res.stderr.toString("utf8");
      if (/not supported|ENOTSUP|EOPNOTSUPP/i.test(stderrText)) {
        aclVerified = false;
      } else {
        return {
          ok: false,
          reason: `failed to read ACLs for ${entryPath}: ${stderrText.trim()}`,
        };
      }
    }
  }

  return { ok: true, xattrs, acls, xattrVerified, aclVerified };
}

/**
 * Inspect extended attribute names AND raw byte values (plus ACLs) without
 * dereferencing symlinks.
 */
export function readEntryMetadata(entryPath: string, isSymlink: boolean): EntryMetadataResult {
  if (process.platform === "darwin") {
    return readDarwinMetadata(entryPath);
  }
  if (process.platform === "linux") {
    return readLinuxMetadata(entryPath, isSymlink);
  }
  return { ok: true, xattrs: {}, acls: [], xattrVerified: false, aclVerified: false };
}
