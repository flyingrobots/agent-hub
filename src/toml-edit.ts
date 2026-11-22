/**
 * TOML 1.0 lexical scanner, surgical [mcp_servers.<name>] span rewriter,
 * unsupported-representation refusal, and mandatory semantic preservation check.
 */
import { isPlainObject, stableJson } from "./paths.ts";

export class TomlUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlUnsupportedError";
  }
}

export class TomlPreservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlPreservationError";
  }
}

export type TomlSection = {
  headerPath: string[];
  isArrayTable: boolean;
  startOffset: number;
  endOffset: number;
  rootAssignments: string[][];
};

export type TomlScanResult = {
  sections: TomlSection[];
  rootAssignments: string[][];
  bareMcpServersHasAssignments: boolean;
};

function isBareKeyChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

function skipInlineWs(src: string, pos: number): number {
  let i = pos;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i += 1;
  return i;
}

/**
 * Parse a dotted key path (bare keys, basic double-quoted keys, literal single-quoted keys)
 * starting at `pos`, stopping at `stopChar` (']' or '=').
 */
function parseKeyPath(
  src: string,
  pos: number,
  stopChars: string,
): { keys: string[]; endPos: number } | null {
  const keys: string[] = [];
  let i = skipInlineWs(src, pos);

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') {
      // Basic quoted key
      let j = i + 1;
      let escaped = false;
      while (j < src.length) {
        const c = src[j]!;
        if (escaped) {
          escaped = false;
          j += 1;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          j += 1;
          continue;
        }
        if (c === "\n" || c === "\r") return null;
        if (c === '"') break;
        j += 1;
      }
      if (j >= src.length || src[j] !== '"') return null;
      const raw = src.slice(i, j + 1);
      try {
        keys.push(JSON.parse(raw) as string);
      } catch {
        return null;
      }
      i = j + 1;
    } else if (ch === "'") {
      // Literal single-quoted key
      let j = i + 1;
      while (j < src.length && src[j] !== "'" && src[j] !== "\n" && src[j] !== "\r") {
        j += 1;
      }
      if (j >= src.length || src[j] !== "'") return null;
      keys.push(src.slice(i + 1, j));
      i = j + 1;
    } else if (isBareKeyChar(ch)) {
      let j = i;
      while (j < src.length && isBareKeyChar(src[j]!)) j += 1;
      keys.push(src.slice(i, j));
      i = j;
    } else {
      return null;
    }

    i = skipInlineWs(src, i);
    if (i < src.length && src[i] === ".") {
      i = skipInlineWs(src, i + 1);
      continue;
    }
    if (i < src.length && stopChars.includes(src[i]!)) {
      return { keys, endPos: i };
    }
    return null;
  }

  return null;
}

/**
 * Lexically scan a TOML 1.0 document, accurately skipping comments, basic/literal
 * single-line and multiline strings ("""...""" / '''...'''), and nested [...] / {...}
 * expressions so table headers are ONLY recognized at true top-level table positions.
 */
export function scanTomlDocument(src: string): TomlScanResult {
  const sections: TomlSection[] = [];
  const rootAssignments: string[][] = [];
  let bareMcpServersHasAssignments = false;
  let currentSection: TomlSection | null = null;

  let i = 0;
  let lineStartOffset = 0;
  let atLineStart = true;
  let depth = 0;

  while (i < src.length) {
    const ch = src[i]!;

    // Handle newlines
    if (ch === "\n") {
      i += 1;
      lineStartOffset = i;
      atLineStart = true;
      continue;
    }
    if (ch === "\r") {
      if (i + 1 < src.length && src[i + 1] === "\n") i += 2;
      else i += 1;
      lineStartOffset = i;
      atLineStart = true;
      continue;
    }

    // Leading indentation before anything on the line
    if (atLineStart && (ch === " " || ch === "\t")) {
      i += 1;
      continue;
    }

    // Comment to end of line
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
      atLineStart = false;
      continue;
    }

    // Top-level table header or array-of-tables header
    if (atLineStart && depth === 0 && ch === "[") {
      const isArrayTable = i + 1 < src.length && src[i + 1] === "[";
      const headerStart = isArrayTable ? i + 2 : i + 1;
      const parsed = parseKeyPath(src, headerStart, "]");
      if (!parsed || parsed.keys.length === 0) {
        throw new TomlUnsupportedError(
          `unable to parse TOML table header at offset ${lineStartOffset}`,
        );
      }
      let closePos = parsed.endPos;
      if (isArrayTable) {
        if (src[closePos] !== "]" || src[closePos + 1] !== "]") {
          throw new TomlUnsupportedError(
            `malformed TOML array-of-tables header at offset ${lineStartOffset}`,
          );
        }
        closePos += 2;
      } else {
        if (src[closePos] !== "]") {
          throw new TomlUnsupportedError(
            `malformed TOML table header at offset ${lineStartOffset}`,
          );
        }
        closePos += 1;
      }

      closePos = skipInlineWs(src, closePos);
      if (closePos < src.length && src[closePos] === "#") {
        while (closePos < src.length && src[closePos] !== "\n" && src[closePos] !== "\r") {
          closePos += 1;
        }
      }
      if (closePos < src.length && src[closePos] !== "\n" && src[closePos] !== "\r") {
        throw new TomlUnsupportedError(
          `unexpected trailing tokens after TOML table header at offset ${lineStartOffset}`,
        );
      }

      if (currentSection) {
        currentSection.endOffset = lineStartOffset;
      }
      currentSection = {
        headerPath: parsed.keys,
        isArrayTable,
        startOffset: lineStartOffset,
        endOffset: src.length,
        rootAssignments: [],
      };
      sections.push(currentSection);

      i = closePos;
      atLineStart = false;
      continue;
    }

    // Track key=value assignments at line start when depth === 0 (for detecting
    // unsupported root mcp_servers = ... or [mcp_servers] inline/dotted entries)
    if (atLineStart && depth === 0) {
      const keyParsed = parseKeyPath(src, i, "=");
      if (keyParsed && keyParsed.keys.length > 0 && src[keyParsed.endPos] === "=") {
        if (!currentSection) {
          rootAssignments.push(keyParsed.keys);
        } else {
          currentSection.rootAssignments.push(keyParsed.keys);
          if (
            currentSection.headerPath.length === 1 &&
            currentSection.headerPath[0] === "mcp_servers"
          ) {
            bareMcpServersHasAssignments = true;
          }
        }
        i = keyParsed.endPos + 1;
        atLineStart = false;
        continue;
      }
    }

    atLineStart = false;

    // Multiline basic string """..."""
    if (ch === '"' && src.slice(i, i + 3) === '"""') {
      i += 3;
      let escaped = false;
      while (i < src.length) {
        const c = src[i]!;
        if (escaped) {
          escaped = false;
          i += 1;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          i += 1;
          continue;
        }
        if (c === '"' && src.slice(i, i + 3) === '"""') {
          // TOML 1.0 allows 1 or 2 additional quotes immediately before closing """
          let run = 0;
          while (i + run < src.length && src[i + run] === '"') run += 1;
          if (run >= 3 && run <= 5) {
            i += run;
            break;
          }
          if (run > 5) {
            throw new TomlUnsupportedError(
              `invalid multiline basic string quote run at offset ${i}`,
            );
          }
        }
        i += 1;
      }
      continue;
    }

    // Multiline literal string '''...'''
    if (ch === "'" && src.slice(i, i + 3) === "'''") {
      i += 3;
      while (i < src.length) {
        if (src[i] === "'" && src.slice(i, i + 3) === "'''") {
          let run = 0;
          while (i + run < src.length && src[i + run] === "'") run += 1;
          if (run >= 3 && run <= 5) {
            i += run;
            break;
          }
          if (run > 5) {
            throw new TomlUnsupportedError(
              `invalid multiline literal string quote run at offset ${i}`,
            );
          }
        }
        i += 1;
      }
      continue;
    }

    // Single-line basic string "..."
    if (ch === '"') {
      i += 1;
      let escaped = false;
      while (i < src.length) {
        const c = src[i]!;
        if (escaped) {
          escaped = false;
          i += 1;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          i += 1;
          continue;
        }
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === "\n" || c === "\r") break;
        i += 1;
      }
      continue;
    }

    // Single-line literal string '...'
    if (ch === "'") {
      i += 1;
      while (i < src.length && src[i] !== "'" && src[i] !== "\n" && src[i] !== "\r") {
        i += 1;
      }
      if (i < src.length && src[i] === "'") i += 1;
      continue;
    }

    // Array / inline-table nesting
    if (ch === "[" || ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    i += 1;
  }

  return { sections, rootAssignments, bareMcpServersHasAssignments };
}

export function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export function normalizeCodexComparable(entry: unknown): Record<string, unknown> {
  if (!isPlainObject(entry)) return {};
  const copy: Record<string, unknown> = { ...entry };
  if (Array.isArray(copy.args) && copy.args.length === 0) delete copy.args;
  if (isPlainObject(copy.env) && Object.keys(copy.env).length === 0) delete copy.env;
  if (isPlainObject(copy.http_headers) && Object.keys(copy.http_headers).length === 0) {
    delete copy.http_headers;
  }
  return copy;
}

export function renderCodexSection(name: string, entry: Record<string, unknown>): string {
  const key = formatTomlKey(name);
  const lines: string[] = [`[mcp_servers.${key}]`];
  if (typeof entry.command === "string") {
    lines.push(`command = ${JSON.stringify(entry.command)}`);
  }
  if (Array.isArray(entry.args) && entry.args.length > 0) {
    lines.push(`args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`);
  }
  if (typeof entry.url === "string") {
    lines.push(`url = ${JSON.stringify(entry.url)}`);
  }
  if (isPlainObject(entry.env) && Object.keys(entry.env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${key}.env]`);
    for (const [k, v] of Object.entries(entry.env as Record<string, string>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${formatTomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }
  if (isPlainObject(entry.http_headers) && Object.keys(entry.http_headers).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${key}.http_headers]`);
    for (const [k, v] of Object.entries(entry.http_headers as Record<string, string>).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      lines.push(`${formatTomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n");
}

export function tomlDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!tomlDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i += 1) {
      const k = keysA[i]!;
      if (k !== keysB[i]) return false;
      if (!tomlDeepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Mandatory semantic preservation invariant:
 * After excluding the explicitly authorized MCP changes in `updates`,
 * every unrelated top-level key and every unmodified mcp_servers.<name> entry
 * in the parsed TOML document MUST remain deeply identical.
 */
export function verifyTomlPreservation(
  original: string,
  rewritten: string,
  updates: Map<string, Record<string, unknown> | null>,
): void {
  const origDoc = original.trim() ? (Bun.TOML.parse(original) as Record<string, unknown>) : {};
  let newDoc: Record<string, unknown>;
  try {
    newDoc = rewritten.trim() ? (Bun.TOML.parse(rewritten) as Record<string, unknown>) : {};
  } catch (err) {
    throw new TomlPreservationError(
      `rewritten TOML failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 1. All top-level keys other than mcp_servers must be identical.
  const allTopKeys = new Set([...Object.keys(origDoc), ...Object.keys(newDoc)]);
  for (const k of allTopKeys) {
    if (k === "mcp_servers") continue;
    const inOrig = Object.prototype.hasOwnProperty.call(origDoc, k);
    const inNew = Object.prototype.hasOwnProperty.call(newDoc, k);
    if (inOrig !== inNew || !tomlDeepEqual(origDoc[k], newDoc[k])) {
      throw new TomlPreservationError(
        `TOML semantic preservation check failed: unrelated top-level key "${k}" changed`,
      );
    }
  }

  // 2. Inside mcp_servers: unmodified keys must match exactly; updated keys must match intent.
  const origMcp: Record<string, unknown> = isPlainObject(origDoc.mcp_servers)
    ? (origDoc.mcp_servers as Record<string, unknown>)
    : {};
  const newMcp: Record<string, unknown> = isPlainObject(newDoc.mcp_servers)
    ? (newDoc.mcp_servers as Record<string, unknown>)
    : {};

  if (origDoc.mcp_servers !== undefined && !isPlainObject(origDoc.mcp_servers)) {
    throw new TomlPreservationError(
      `TOML semantic preservation check failed: original mcp_servers is not a table`,
    );
  }
  if (newDoc.mcp_servers !== undefined && !isPlainObject(newDoc.mcp_servers)) {
    throw new TomlPreservationError(
      `TOML semantic preservation check failed: rewritten mcp_servers is not a table`,
    );
  }

  const allServerNames = new Set([
    ...Object.keys(origMcp),
    ...Object.keys(newMcp),
    ...updates.keys(),
  ]);

  for (const name of allServerNames) {
    if (!updates.has(name)) {
      const inOrig = Object.prototype.hasOwnProperty.call(origMcp, name);
      const inNew = Object.prototype.hasOwnProperty.call(newMcp, name);
      if (inOrig !== inNew || !tomlDeepEqual(origMcp[name], newMcp[name])) {
        throw new TomlPreservationError(
          `TOML semantic preservation check failed: unmodified mcp_servers.${name} changed`,
        );
      }
      continue;
    }

    const desired = updates.get(name)!;
    const inNew = Object.prototype.hasOwnProperty.call(newMcp, name);
    if (desired === null) {
      if (inNew) {
        throw new TomlPreservationError(
          `TOML semantic preservation check failed: removed mcp_servers.${name} is still present`,
        );
      }
    } else {
      if (!inNew) {
        throw new TomlPreservationError(
          `TOML semantic preservation check failed: updated mcp_servers.${name} is missing`,
        );
      }
      if (stableJson(normalizeCodexComparable(newMcp[name])) !== stableJson(desired)) {
        throw new TomlPreservationError(
          `TOML semantic preservation check failed: updated mcp_servers.${name} does not match desired spec`,
        );
      }
    }
  }
}

/**
 * Surgically rewrite Codex config.toml for the specified `updates` map
 * (serverName -> desired entry or null for removal), refusing unsupported
 * representations and verifying full semantic preservation before returning.
 */
export function rewriteCodexToml(
  original: string,
  updates: Map<string, Record<string, unknown> | null>,
): string {
  // Parse original upfront to catch malformed TOML before scanning.
  if (original.trim()) {
    Bun.TOML.parse(original);
  }

  const scan = scanTomlDocument(original);

  // Refuse unsupported representations that cannot be safely excised by section span.
  for (const keyPath of scan.rootAssignments) {
    if (keyPath[0] === "mcp_servers") {
      throw new TomlUnsupportedError(
        `Codex config uses a root-level or dotted "mcp_servers" assignment (${keyPath.join(".")}) that cannot be safely edited without risking unrelated settings`,
      );
    }
  }

  for (const sec of scan.sections) {
    if (sec.headerPath[0] !== "mcp_servers") continue;
    if (sec.isArrayTable) {
      throw new TomlUnsupportedError(
        `Codex config uses an unsupported array-of-tables header [[${sec.headerPath.join(".")}]]`,
      );
    }
    if (sec.headerPath.length === 1) {
      throw new TomlUnsupportedError(
        `Codex config uses a bare [mcp_servers] table header (inline/dotted entries) that cannot be safely edited without risking unrelated settings`,
      );
    }
  }

  // Collect exact character spans to excise: any [mcp_servers.<name>] or [mcp_servers.<name>.*]
  // where <name> is in `updates`.
  const spansToRemove: Array<{ start: number; end: number }> = [];
  for (const sec of scan.sections) {
    if (
      sec.headerPath[0] === "mcp_servers" &&
      sec.headerPath.length >= 2 &&
      updates.has(sec.headerPath[1]!)
    ) {
      spansToRemove.push({ start: sec.startOffset, end: sec.endOffset });
    }
  }
  spansToRemove.sort((a, b) => a.start - b.start);

  // Build remaining document preserving everything outside excised spans byte-for-byte.
  let remaining = "";
  let cursor = 0;
  for (const span of spansToRemove) {
    if (span.start > cursor) {
      remaining += original.slice(cursor, span.start);
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < original.length) {
    remaining += original.slice(cursor);
  }

  // Trim trailing blank lines cleanly without altering internal content/strings.
  remaining = remaining.replace(/(?:\r?\n[ \t]*)+$/, "");

  const additions = [...updates.entries()]
    .filter(([, v]) => v !== null)
    .sort(([a], [b]) => a.localeCompare(b));

  const chunks: string[] = [];
  if (remaining.length > 0) chunks.push(remaining);
  for (const [name, entry] of additions) {
    chunks.push(renderCodexSection(name, entry!));
  }

  const rewritten = chunks.length > 0 ? `${chunks.join("\n\n")}\n` : "";

  verifyTomlPreservation(original, rewritten, updates);
  return rewritten;
}
