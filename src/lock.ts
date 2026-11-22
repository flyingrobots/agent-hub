/**
 * Isolated OS-held advisory flock(2) writer lock on a stable, never-unlinked inode,
 * with exact thread-local errno inspection (__error on macOS, __errno_location on Linux).
 *
 * Note: Bun currently marks `bun:ffi` as experimental. This module isolates the
 * syscall bindings behind a fail-closed interface validated on macOS and Linux.
 */
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import {
  closeSync,
  constants as fsConstants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

// Verified identical on macOS (<sys/fcntl.h>) and Linux (<sys/file.h>).
const LOCK_EX = 0x02;
const LOCK_NB = 0x04;
const LOCK_UN = 0x08;

export const ERRNO_MAP = {
  EINTR: 4,
  EBADF: 9,
  EAGAIN: process.platform === "darwin" ? 35 : 11,
  EWOULDBLOCK: process.platform === "darwin" ? 35 : 11,
  ENOLCK: process.platform === "darwin" ? 77 : 37,
  ENOTSUP: process.platform === "darwin" ? 45 : 95,
  EOPNOTSUPP: process.platform === "darwin" ? 102 : 95,
} as const;

type NativeLockBindings = {
  flock: (fd: number, operation: number) => number;
  getErrno: () => number;
};

let cachedBindings: NativeLockBindings | null = null;

function loadBindings(): NativeLockBindings {
  if (cachedBindings) return cachedBindings;

  if (process.platform === "darwin") {
    const lib = dlopen("libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    cachedBindings = {
      flock: (fd, op) => lib.symbols.flock(fd, op),
      getErrno: () => {
        const p = lib.symbols.__error() as Pointer | null;
        return p ? read.i32(p, 0) : 0;
      },
    };
    return cachedBindings;
  }

  if (process.platform === "linux") {
    const candidates = ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];
    let lastErr: unknown = null;
    for (const libName of candidates) {
      try {
        const lib = dlopen(libName, {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
          __errno_location: { args: [], returns: FFIType.ptr },
        });
        cachedBindings = {
          flock: (fd, op) => lib.symbols.flock(fd, op),
          getErrno: () => {
            const p = lib.symbols.__errno_location() as Pointer | null;
            return p ? read.i32(p, 0) : 0;
          },
        };
        return cachedBindings;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new LockSystemError(
      `agent-hub: failed to load flock(2) from ${candidates.join(", ")}: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
      0,
    );
  }

  throw new LockSystemError(
    `agent-hub: OS advisory flock(2) locking is unsupported on platform "${process.platform}"; refusing to proceed without writer exclusion`,
    0,
  );
}

export type ApplyLockHandle = {
  fd: number;
  lockPath: string;
  released: boolean;
};

export class LockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockBusyError";
  }
}

export class LockSystemError extends Error {
  readonly errno: number;

  constructor(message: string, errno: number) {
    super(message);
    this.name = "LockSystemError";
    this.errno = errno;
  }
}

export function describeFlockErrno(errno: number, platform = process.platform): string {
  const eagain = platform === "darwin" ? 35 : 11;
  const enolck = platform === "darwin" ? 77 : 37;
  const enotsup = platform === "darwin" ? 45 : 95;
  const eopnotsupp = platform === "darwin" ? 102 : 95;

  if (errno === 4) return "EINTR (interrupted system call)";
  if (errno === 9) return "EBADF (invalid file descriptor)";
  if (errno === eagain) return "EWOULDBLOCK/EAGAIN (lock held by another process)";
  if (errno === enolck) return "ENOLCK (kernel lock table exhausted)";
  if (errno === enotsup || errno === eopnotsupp) {
    return "EOPNOTSUPP/ENOTSUP (filesystem does not support flock(2))";
  }
  return `errno=${errno}`;
}

/**
 * Classify a non-zero flock(2) failure strictly by errno so non-contention kernel/FS
 * errors (EBADF, ENOLCK, EOPNOTSUPP, EINTR) are NEVER misreported as LockBusyError.
 */
export function classifyFlockErrno(
  errno: number,
  lockPath: string,
  holderInfo = "",
  platform = process.platform,
): LockBusyError | LockSystemError {
  const eagain = platform === "darwin" ? 35 : 11;
  if (errno === eagain) {
    return new LockBusyError(
      `another sync-agents apply process holds ${lockPath}${holderInfo}; retry after it exits`,
    );
  }
  return new LockSystemError(
    `flock(2) failed on ${lockPath}: ${describeFlockErrno(errno, platform)}`,
    errno,
  );
}

/**
 * Execute flock(2) with bounded EINTR retry and exact errno capture.
 */
export function flockFdWithErrno(
  fd: number,
  operation: number,
  maxEintrRetries = 8,
): { ok: true } | { ok: false; errno: number } {
  const { flock, getErrno } = loadBindings();
  for (let attempt = 0; attempt <= maxEintrRetries; attempt += 1) {
    const rc = flock(fd, operation);
    if (rc === 0) return { ok: true };
    const errno = getErrno();
    if (errno === ERRNO_MAP.EINTR && attempt < maxEintrRetries) {
      continue;
    }
    return { ok: false, errno };
  }
  return { ok: false, errno: ERRNO_MAP.EINTR };
}

function readLockHolderInfo(lockPath: string): string {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { pid?: number; hubPath?: string; startedAt?: string };
    const parts: string[] = [];
    if (typeof parsed.pid === "number") parts.push(`pid=${parsed.pid}`);
    if (typeof parsed.hubPath === "string") parts.push(`hub=${parsed.hubPath}`);
    if (typeof parsed.startedAt === "string") parts.push(`since=${parsed.startedAt}`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  } catch {
    return "";
  }
}

/**
 * Acquire an exclusive, non-blocking OS advisory lock on a stable lockfile inode.
 * The lock file is NEVER unlinked during release or recovery; the OS kernel
 * automatically releases the lock on process exit or SIGKILL.
 */
export function acquireApplyLock(lockPath: string, hubPath: string): ApplyLockHandle {
  loadBindings();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  const flags = fsConstants.O_CREAT | fsConstants.O_RDWR;
  const fd = openSync(lockPath, flags, 0o600);

  const res = flockFdWithErrno(fd, LOCK_EX | LOCK_NB);
  if (!res.ok) {
    closeSync(fd);
    const holderInfo = res.errno === ERRNO_MAP.EWOULDBLOCK ? readLockHolderInfo(lockPath) : "";
    throw classifyFlockErrno(res.errno, lockPath, holderInfo);
  }

  // Write informational metadata without unlinking or replacing the inode.
  try {
    ftruncateSync(fd, 0);
    const meta =
      JSON.stringify({
        pid: process.pid,
        hubPath,
        startedAt: new Date().toISOString(),
      }) + "\n";
    writeSync(fd, meta, 0, "utf8");
  } catch {
    // Metadata write failure does not affect kernel lock ownership.
  }

  return { fd, lockPath, released: false };
}

/**
 * Release the OS advisory lock and close its descriptor.
 * Intentionally NEVER unlinks `lockPath` so contenders always lock the same inode.
 */
export function releaseApplyLock(handle: ApplyLockHandle | null | undefined): void {
  if (!handle || handle.released) return;
  handle.released = true;
  try {
    flockFdWithErrno(handle.fd, LOCK_UN);
  } catch {
    // Closing fd also releases the kernel lock.
  }
  try {
    closeSync(handle.fd);
  } catch {
    // Already closed.
  }
}
