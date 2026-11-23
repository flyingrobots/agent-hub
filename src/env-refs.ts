/**
 * Portable environment references in canonical MCP specs: `${env:NAME}`, NAME matching
 * ^[A-Z_][A-Z0-9_]*$. Each adapter compiles a reference to its agent's own syntax, or refuses it.
 * Nothing here reads the environment: values are resolved by the agent when it starts a server.
 */
import type { McpServerSpec } from "./types.ts";

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const OPEN = "${env:";

export class EnvRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvRefError";
  }
}

export type EnvRefPart = { kind: "literal"; text: string } | { kind: "ref"; name: string };

/** Split a string into literal text and `${env:NAME}` references. Throws on a malformed one. */
export function parseEnvRefs(s: string): EnvRefPart[] {
  const parts: EnvRefPart[] = [];
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf(OPEN, i);
    if (at === -1) {
      parts.push({ kind: "literal", text: s.slice(i) });
      break;
    }
    if (at > i) parts.push({ kind: "literal", text: s.slice(i, at) });
    const close = s.indexOf("}", at + OPEN.length);
    // Messages never quote the value: it may hold a secret next to the broken reference.
    if (close === -1) throw new EnvRefError("unterminated ${env:...} reference");
    const name = s.slice(at + OPEN.length, close);
    if (!ENV_NAME.test(name)) {
      throw new EnvRefError("invalid ${env:...} reference: the name must match ^[A-Z_][A-Z0-9_]*$");
    }
    parts.push({ kind: "ref", name });
    i = close + 1;
  }
  return parts;
}

export function hasEnvRef(s: string): boolean {
  return parseEnvRefs(s).some((p) => p.kind === "ref");
}

/** NAME when the whole string is exactly one reference, otherwise null. */
export function exactEnvRef(s: string): string | null {
  const parts = parseEnvRefs(s);
  return parts.length === 1 && parts[0]!.kind === "ref" ? parts[0]!.name : null;
}

/** Replace each reference with render(NAME), keeping literal text. */
export function rewriteEnvRefs(s: string, render: (name: string) => string): string {
  return parseEnvRefs(s)
    .map((p) => (p.kind === "ref" ? render(p.name) : p.text))
    .join("");
}

/** The spec's string fields with their paths (`command`, `args[1]`, `env.K`, `url`, `headers.H`). */
export function specFields(spec: McpServerSpec): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (typeof spec.command === "string") out.push(["command", spec.command]);
  (spec.args ?? []).forEach((a, i) => out.push([`args[${i}]`, a]));
  for (const [k, v] of Object.entries(spec.env ?? {})) out.push([`env.${k}`, v]);
  if (typeof spec.url === "string") out.push(["url", spec.url]);
  for (const [k, v] of Object.entries(spec.headers ?? {})) out.push([`headers.${k}`, v]);
  return out;
}

/** The spec with every string field rewritten by `render` (parsing, and so validating, each). */
export function mapSpecRefs(spec: McpServerSpec, render: (name: string) => string): McpServerSpec {
  const map = (s: string) => rewriteEnvRefs(s, render);
  const mapRecord = (r: Record<string, string> | undefined) =>
    r === undefined ? undefined : Object.fromEntries(Object.entries(r).map(([k, v]) => [k, map(v)]));
  const out: McpServerSpec = { ...spec };
  if (spec.command !== undefined) out.command = map(spec.command);
  if (spec.args !== undefined) out.args = spec.args.map(map);
  if (spec.env !== undefined) out.env = mapRecord(spec.env);
  if (spec.url !== undefined) out.url = map(spec.url);
  if (spec.headers !== undefined) out.headers = mapRecord(spec.headers);
  return out;
}

/** Throws EnvRefError, naming the field, for any malformed reference in the spec. */
export function validateSpecRefs(spec: McpServerSpec): void {
  for (const [field, v] of specFields(spec)) {
    try {
      parseEnvRefs(v);
    } catch (err) {
      throw new EnvRefError(`${field}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type PlaintextWarning = { field: string; reason: string };

// Known token shapes. Deliberately narrow: each is a published prefix or format.
const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, "looks like an API secret key (sk-...)"],
  [/\bghp_[A-Za-z0-9]{20,}/, "looks like a GitHub personal access token (ghp_...)"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "looks like a GitHub fine-grained token (github_pat_...)"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "looks like a Slack token (xox?-...)"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "looks like a Google API key (AIza...)"],
  [/\bAKIA[0-9A-Z]{16}\b/, "looks like an AWS access key id (AKIA...)"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "looks like a PEM private key"],
];
// Field names that usually hold a credential.
// Matched against a name's segments (split on _, - and .), so AUTHOR, MAX_TOKENS or
// X-Session-Id do not count; API_KEY, X-Api-Key, ACCESS_KEY and PRIVATE_KEY do.
const SECRET_SEGMENTS = new Set(["token", "secret", "password", "passwd", "pwd", "apikey", "credential", "credentials", "authorization", "bearer"]);
const SECRET_PAIRS: Array<[string, string]> = [["api", "key"], ["access", "key"], ["private", "key"], ["secret", "key"], ["auth", "token"]];
function isSecretName(name: string): boolean {
  const seg = name.toLowerCase().split(/[_.\-]+/).filter(Boolean);
  if (seg.some((s) => SECRET_SEGMENTS.has(s))) return true;
  return SECRET_PAIRS.some(([a, b]) => seg.some((s, i) => s === a && seg[i + 1] === b));
}

/**
 * Literal values that look like credentials: a known token pattern anywhere, any non-empty
 * literal under a secret-bearing env key or header name, or a URL with embedded credentials.
 * References (`${env:...}`) are not literals. Fields named in `allow` are skipped.
 */
export function detectPlaintextSecrets(spec: McpServerSpec, allow: readonly string[] = []): PlaintextWarning[] {
  const allowed = new Set(allow);
  const warnings: PlaintextWarning[] = [];
  for (const [field, value] of specFields(spec)) {
    if (allowed.has(field)) continue;
    // Each literal part on its own: text on two sides of a reference was never contiguous.
    let parts: string[];
    try {
      parts = parseEnvRefs(value)
        .filter((p) => p.kind === "literal")
        .map((p) => (p as { text: string }).text);
    } catch {
      parts = [value];
    }
    const literal = parts.join(" ");
    const pattern = TOKEN_PATTERNS.find(([re]) => parts.some((p) => re.test(p)));
    if (pattern) {
      warnings.push({ field, reason: pattern[1] });
      continue;
    }
    const name = field.startsWith("env.") ? field.slice(4) : field.startsWith("headers.") ? field.slice(8) : null;
    // "Bearer " or "Basic " alone is the scheme, not the credential.
    if (name !== null && isSecretName(name) && literal.replace(/^(Bearer|Basic|Token)\s*/i, "").trim().length > 0) {
      warnings.push({ field, reason: `"${name}" usually holds a credential and has a literal value` });
      continue;
    }
    if (field === "url" && /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(literal)) {
      warnings.push({ field, reason: "the URL embeds a user name and password" });
    }
  }
  return warnings;
}
