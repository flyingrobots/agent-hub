#!/usr/bin/env bun
/**
 * Thin standalone MCP-only entrypoint delegating to src/cli.ts (`cliMain` with mcpOnly), so flag
 * parsing, output (JSON Lines by default, --human for prose), recovery, locking and errors are
 * identical to sync-agents.
 */
import { cliMain } from "./cli.ts";

const MCP_USAGE =
  "Usage: mcp-sync.ts [--dir <path>] [--targets <csv>] [--dry-run|-n] [--check] [--adopt] [--force] [--explain] [--disown-legacy <agent>:<name>] [--print-dir] [--human] [--schema]";

// exitCode, not process.exit(): exiting at once drops whatever a slow pipe has not yet taken.
process.exitCode = cliMain(process.argv.slice(2), "mcp-sync", MCP_USAGE, true);
