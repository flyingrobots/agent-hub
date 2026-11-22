/**
 * Isolated OS-held advisory flock(2) writer lock on a stable, never-unlinked inode.
 *
 * Note: Bun currently marks `bun:ffi` as experimental. This module isolates the
 * single scalar syscall binding (`flock(fd, op) -> i32`) behind a fail-closed
 * interface validated on macOS (libSystem.B.dylib) and Linux (libc.so.6).
 */
import { dlopen, FFIType } from "bun:ffi";
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

type FlockFn = (fd: number, operation: number) => number;

let cachedFlock: FlockFn | null = null;

function loadFlock(): FlockFn {
  if (cachedFlock) return cachedFlock;

  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib"]
      : process.platform === "linux"
        ? ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"]
        : [];

  if (candidates.length === 0) {
    throw new Error(
      `agent-hub: OS advisory flock(2) locking is unsupported on platform "${process.platform}"; refusing to proceed without writer exclusion`,
    );
  }

  let lastErr: unknown = null;
  for (const libName of candidates) {
    try {
      const lib = dlopen(libName, {
        flock: {
          args: [FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
      });
      cachedFlock = (fd: number, op: number) => lib.symbols.flock(fd, op);
      return cachedFlock;
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `agent-hub: failed to load flock(2) from ${candidates.join(", ")}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
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

/**
 * Acquire an exclusive, non-blocking OS advisory lock on a stable lockfile inode.
 * The lock file is NEVER unlinked during release or recovery; the OS kernel
 * automatically releases the lock on process exit or SIGKILL.
 */
export function acquireApplyLock(lockPath: string, hubPath: string): ApplyLockHandle {
  const flock = loadFlock();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  const flags = fsConstants.O_CREAT | fsConstants.O_RDWR;
  const fd = openSync(lockPath, flags, 0o600);

  const rc = flock(fd, LOCK_EX | LOCK_NB);
  if (rc !== 0) {
    let holderInfo = "";
    try {
      const raw = readFileSync(lockPath, "utf8").trim();
      if (raw) {
        const parsed = JSON.parse(raw) as { pid?: number; hubPath?: string; startedAt?: string };
        const parts: string[] = [];
        if (typeof parsed.pid === "number") parts.push(`pid=${parsed.pid}`);
        if (typeof parsed.hubPath === "string") parts.push(`hub=${parsed.hubPath}`);
        if (typeof parsed.startedAt === "string") parts.push(`since=${parsed.startedAt}`);
        if (parts.length > 0) holderInfo = ` (${parts.join(", ")})`;
      }
    } catch {
      // Informational metadata only; kernel lock is the sole authority.
    }
    closeSync(fd);
    throw new LockBusyError(
      `another sync-agents apply process holds ${lockPath}${holderInfo}; retry after it exits`,
    );
  }

  // Write informational metadata without unlinking or replacing the inode.
  try {
    ftruncateSync(fd, 0);
    const meta = JSON.stringify({
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
    const flock = loadFlock();
    flock(handle.fd, LOCK_UN);
  } catch {
    // Closing fd also releases the kernel lock.
  }
  try {
    closeSync(handle.fd);
  } catch {
    // Already closed.
  }
}
