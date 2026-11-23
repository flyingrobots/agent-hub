/**
 * TOML 1.0 lexical scanner, surgical [mcp_servers.<name>] span rewriter,
 * unsupported-representation refusal, CRLF preservation, and mandatory
 * semantic preservation verification.
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
  /** Offset just past the section's last token outside a comment (strings included whole). */
  lastTokenEnd: number;
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
 * Decode a TOML 1.0/1.1 basic double-quoted string (including quotes), supporting
 * \b, \t, \n, \f, \r, \", \\, \e, \xHH, \uXXXX, and \UXXXXXXXX scalar escapes.
 */
export function decodeTomlBasicString(raw: string): string | null {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return null;
  let out = "";
  let i = 1;
  const end = raw.length - 1;

  while (i < end) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    if (i + 1 >= end) return null;
    const esc = raw[i + 1]!;
    switch (esc) {
      case "b":
        out += "\b";
        i += 2;
        break;
      case "t":
        out += "\t";
        i += 2;
        break;
      case "n":
        out += "\n";
        i += 2;
        break;
      case "f":
        out += "\f";
        i += 2;
        break;
      case "r":
        out += "\r";
        i += 2;
        break;
      case "e":
        out += "\u001b";
        i += 2;
        break;
      case '"':
        out += '"';
        i += 2;
        break;
      case "\\":
        out += "\\";
        i += 2;
        break;
      case "x": {
        const hex = raw.slice(i + 2, i + 4);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 4;
        break;
      }
      case "u": {
        const hex = raw.slice(i + 2, i + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (cp >= 0xd800 && cp <= 0xdfff) return null;
        out += String.fromCodePoint(cp);
        i += 6;
        break;
      }
      case "U": {
        const hex = raw.slice(i + 2, i + 10);
        if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
        out += String.fromCodePoint(cp);
        i += 10;
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

/**
 * Parse a dotted key path (bare keys, basic double-quoted keys, literal single-quoted keys)
 * starting at `pos`, stopping at `stopChars` (']' or '=').
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
      const decoded = decodeTomlBasicString(src.slice(i, j + 1));
      if (decoded === null) return null;
      keys.push(decoded);
      i = j + 1;
    } else if (ch === "'") {
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

  // A leading UTF-8 BOM is not content: the first line starts after it (it stays in the output
  // as part of the text before the first section).
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let lineStartOffset = i;
  let atLineStart = true;
  let depth = 0;
  // Every branch below that consumes a token (not whitespace, a newline or a comment) marks
  // where it ended, so each section knows its last content without re-parsing.
  const mark = () => {
    if (currentSection) currentSection.lastTokenEnd = i;
  };

  while (i < src.length) {
    const ch = src[i]!;

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

    if (atLineStart && (ch === " " || ch === "\t")) {
      i += 1;
      continue;
    }

    if (ch === "#") {
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
      atLineStart = false;
      continue;
    }

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
      const headerContentEnd = closePos;

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
        lastTokenEnd: lineStartOffset,
        rootAssignments: [],
      };
      sections.push(currentSection);

      // The header itself is content; a trailing comment after it is not.
      i = closePos;
      currentSection.lastTokenEnd = headerContentEnd;
      atLineStart = false;
      continue;
    }

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
        mark();
        atLineStart = false;
        continue;
      }
    }

    atLineStart = false;

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
      mark();
      continue;
    }

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
      mark();
      continue;
    }

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
      mark();
      continue;
    }

    if (ch === "'") {
      i += 1;
      while (i < src.length && src[i] !== "'" && src[i] !== "\n" && src[i] !== "\r") {
        i += 1;
      }
      if (i < src.length && src[i] === "'") i += 1;
      mark();
      continue;
    }

    if (ch === "[" || ch === "{") {
      depth += 1;
      i += 1;
      mark();
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      i += 1;
      mark();
      continue;
    }

    i += 1;
    if (ch !== " " && ch !== "\t") mark();
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
  if (isPlainObject(copy.env_http_headers) && Object.keys(copy.env_http_headers).length === 0) {
    delete copy.env_http_headers;
  }
  if (Array.isArray(copy.env_vars) && copy.env_vars.length === 0) delete copy.env_vars;
  return copy;
}

/** Keys renderCodexSection writes itself; any other key is an `extra` native field. */
const CODEX_MANAGED = new Set([
  "command",
  "args",
  "url",
  "env",
  "env_vars",
  "http_headers",
  "bearer_token_env_var",
  "env_http_headers",
]);

function tomlScalar(v: unknown, where: string): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return Number.isInteger(v) ? String(v) : String(v);
  throw new TomlUnsupportedError(`${where}: only strings, finite numbers and booleans can be written to Codex TOML`);
}

function tomlScalarOrArray(v: unknown, where: string): string {
  if (Array.isArray(v)) return `[${v.map((x, i) => tomlScalar(x, `${where}[${i}]`)).join(", ")}]`;
  return tomlScalar(v, where);
}

export function renderCodexSection(
  name: string,
  entry: Record<string, unknown>,
  eol = "\n",
): string {
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
  // Variables Codex reads from its own environment (flyingrobots/agent-hub#6).
  if (typeof entry.bearer_token_env_var === "string") {
    lines.push(`bearer_token_env_var = ${JSON.stringify(entry.bearer_token_env_var)}`);
  }
  if (Array.isArray(entry.env_vars) && entry.env_vars.length > 0) {
    lines.push(`env_vars = [${entry.env_vars.map((v) => JSON.stringify(v)).join(", ")}]`);
  }
  // Native fields from overrides.codex.extra (flyingrobots/agent-hub#7): scalars and arrays of
  // scalars as keys here, objects of scalars as subtables after the managed ones.
  const extraKeys = Object.keys(entry).filter((k) => !CODEX_MANAGED.has(k)).sort();
  const extraTables: string[] = [];
  for (const k of extraKeys) {
    const v = entry[k];
    if (isPlainObject(v)) {
      extraTables.push(k);
      continue;
    }
    lines.push(`${formatTomlKey(k)} = ${tomlScalarOrArray(v, `mcp_servers.${name}.${k}`)}`);
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
  for (const table of ["http_headers", "env_http_headers"] as const) {
    if (isPlainObject(entry[table]) && Object.keys(entry[table]).length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${key}.${table}]`);
      for (const [k, v] of Object.entries(entry[table] as Record<string, string>).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        lines.push(`${formatTomlKey(k)} = ${JSON.stringify(v)}`);
      }
    }
  }
  for (const t of extraTables) {
    lines.push("");
    lines.push(`[mcp_servers.${key}.${formatTomlKey(t)}]`);
    for (const [k, v] of Object.entries(entry[t] as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      if (isPlainObject(v)) {
        throw new TomlUnsupportedError(`mcp_servers.${name}.${t}.${k}: nested tables in extra are not supported`);
      }
      lines.push(`${formatTomlKey(k)} = ${tomlScalarOrArray(v, `mcp_servers.${name}.${t}.${k}`)}`);
    }
  }
  return lines.join(eol);
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

let cutFallbacks = 0;

/** How many managed-table cuts fell back to the whole span (expected to stay zero). */
export function tomlCutFallbacks(): number {
  return cutFallbacks;
}

/**
 * Where to cut a managed table's span: just past the line holding its last token (from the
 * scanner, which reads strings whole, so the cut can never fall inside a multiline string). The
 * trailing blank and comment lines after it are left in place. One parse-equivalence check
 * guards the result; if the table alone does not parse to the same value as its whole span, the
 * whole span is used and counted as a fallback.
 */
export function sectionCut(src: string, sec: TomlSection): number {
  const { startOffset: start, endOffset: end } = sec;
  let cut = Math.min(Math.max(sec.lastTokenEnd, start), end);
  if (cut < end) {
    const nl = src.indexOf("\n", cut);
    cut = nl === -1 || nl + 1 > end ? end : nl + 1;
  }
  if (cut === end) return end;
  try {
    const full = JSON.stringify(Bun.TOML.parse(src.slice(start, end)));
    if (JSON.stringify(Bun.TOML.parse(src.slice(start, cut))) === full) return cut;
  } catch {
    // fall through to the counted fallback
  }
  cutFallbacks += 1;
  return end;
}

export function rewriteCodexToml(
  original: string,
  updates: Map<string, Record<string, unknown> | null>,
): string {
  if (original.trim()) {
    Bun.TOML.parse(original);
  }

  const eol = /\r\n/.test(original) ? "\r\n" : "\n";
  const scan = scanTomlDocument(original);

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

  // Each managed section's span runs from its header to the next header. Trailing blank and
  // comment lines inside that span belong, to a reader, to whatever follows (usually the next
  // table's leading comment), so a span is cut only up to its last content line. An updated
  // section is rendered where the first of its sections stood; only new servers are appended.
  const spans: Array<{ start: number; end: number; name: string }> = [];
  for (const sec of scan.sections) {
    if (
      sec.headerPath[0] === "mcp_servers" &&
      sec.headerPath.length >= 2 &&
      updates.has(sec.headerPath[1]!)
    ) {
      spans.push({
        start: sec.startOffset,
        end: sectionCut(original, sec),
        name: sec.headerPath[1]!,
      });
    }
  }
  spans.sort((a, b) => a.start - b.start);

  let out = "";
  let cursor = 0;
  const placed = new Set<string>();
  let previousName: string | null = null;
  for (const span of spans) {
    const gap = span.start > cursor ? original.slice(cursor, span.start) : "";
    // The blank lines between one server's own tables ([x] and [x.env]) are regenerated with it;
    // re-emitting them would add a blank line on every rewrite.
    const sameServerGap = previousName === span.name && gap.trim().length === 0;
    if (gap && !sameServerGap) out += gap;
    previousName = span.name;
    const entry = updates.get(span.name);
    if (entry && !placed.has(span.name)) {
      out += renderCodexSection(span.name, entry, eol) + eol;
      placed.add(span.name);
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < original.length) out += original.slice(cursor);

  const remaining = out.replace(/(?:\r?\n[ \t]*)+$/, "");
  const additions = [...updates.entries()]
    .filter(([name, v]) => v !== null && !placed.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

  const chunks: string[] = [];
  if (remaining.length > 0) chunks.push(remaining);
  for (const [name, entry] of additions) {
    chunks.push(renderCodexSection(name, entry!, eol));
  }

  const rewritten = chunks.length > 0 ? `${chunks.join(`${eol}${eol}`)}${eol}` : "";

  verifyTomlPreservation(original, rewritten, updates);
  return rewritten;
}
