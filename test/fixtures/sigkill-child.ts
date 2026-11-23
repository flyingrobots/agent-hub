/**
 * Compiled-binary SIGKILL harness for test/binary.test.ts.
 *
 * test/binary.test.ts compiles this file with `bun build --compile`, so the flock(2)
 * and xattr FFI bindings it exercises are the bundled, compiled ones — not the
 * interpreter's. It runs a real `runSync` apply, and right after the target symlink is
 * mutated (before the ownership ledger commits) it writes a ready marker and blocks
 * until the parent test SIGKILLs it, so no finally/catch block can release the lock.
 *
 * Arguments: <hubDir> <homeDir> <xdgConfigHome> <xdgStateHome> <targetLink> <markerFile>
 */
import { writeFileSync } from "node:fs";
import { runSync } from "../../src/cli.ts";

const [hubDir, homeDir, xdgConfigHome, xdgStateHome, targetLink, markerFile] = process.argv.slice(2);
if (!hubDir || !homeDir || !xdgConfigHome || !xdgStateHome || !targetLink || !markerFile) {
  console.error("sigkill-child: expected 6 arguments");
  process.exit(2);
}

const res = runSync(
  { hubDir, homeDir, xdgConfigHome, xdgStateHome },
  {
    afterTargetMutate(journal) {
      if (journal.destination === targetLink) {
        writeFileSync(markerFile, "ready");
        // Block until SIGKILL; the parent never lets this time out.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      }
    },
  },
);
// Reaching here means the barrier was never hit or the parent never killed us.
console.error(`sigkill-child: apply finished without being killed (exit ${res.exitCode})`);
process.exit(3);
