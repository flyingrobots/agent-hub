#!/usr/bin/env bun
/**
 * Thin standalone MCP-only entrypoint delegating directly to src/cli.ts (`runSync`
 * with `mcpOnly: true`), ensuring identical flag parsing, --explain output, Phase 0
 * recovery, locking, and error formatting.
 */
import { parseCliArgs, runSync } from "./cli.ts";

const MCP_USAGE =
  "Usage: mcp-sync.ts [--dir <path>] [--targets <csv>] [--dry-run|-n] [--check] [--adopt] [--force] [--explain] [--disown-legacy <agent>:<name>]";

let parsed;
try {
  parsed = parseCliArgs(process.argv.slice(2));
} catch (err) {
  console.error(`mcp-sync: ${err instanceof Error ? err.message : String(err)}`);
  console.error(MCP_USAGE);
  process.exit(2);
}

if (parsed.showHelp) {
  console.log(MCP_USAGE);
  process.exit(0);
}

const res = runSync({ ...parsed.options, mcpOnly: true });
for (const line of res.stdout) console.log(line);
for (const line of res.stderr) console.error(line);
process.exit(res.exitCode);
