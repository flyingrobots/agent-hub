/**
 * Test-side half of the output contract: every line sync-agents prints must be a JSON object that
 * validates against the schema it names in `_schema`. decodeOutput enforces that (throwing on any
 * non-conforming line) and hands back the human messages, so assertions written against prose keep
 * their meaning while every run also validates the machine contract.
 */
import Ajv2020 from "ajv/dist/2020";
import { SCHEMAS, type SchemaId } from "../src/output.ts";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map(
  (Object.keys(SCHEMAS) as SchemaId[]).map((id) => [id, ajv.compile(SCHEMAS[id] as object)]),
);

export type DecodedEvent = Record<string, unknown> & { _schema: { id: string; version: string } };

export function decodeStream(text: string, streamName: string): { messages: string[]; events: DecodedEvent[] } {
  const messages: string[] = [];
  const events: DecodedEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let obj: DecodedEvent;
    try {
      obj = JSON.parse(line) as DecodedEvent;
    } catch {
      throw new Error(`${streamName}: not a JSON line: ${line.slice(0, 300)}`);
    }
    const id = obj?._schema?.id as SchemaId | undefined;
    const validate = id ? validators.get(id) : undefined;
    if (!validate) throw new Error(`${streamName}: unknown or missing _schema.id: ${line.slice(0, 300)}`);
    if (!validate(obj)) {
      throw new Error(`${streamName}: ${id} does not validate (${ajv.errorsText(validate.errors)}): ${line.slice(0, 300)}`);
    }
    messages.push(obj.message as string);
    events.push(obj);
  }
  return { messages, events };
}

/** Validate both streams of a sync-agents run; return their human messages as text, plus events. */
export function decodeOutput(stdout: string, stderr: string) {
  const out = decodeStream(stdout, "stdout");
  const err = decodeStream(stderr, "stderr");
  const join = (m: string[]) => (m.length > 0 ? `${m.join("\n")}\n` : "");
  return { stdout: join(out.messages), stderr: join(err.messages), events: [...out.events, ...err.events] };
}

/** True when a spawned command is sync-agents (the wrapper, the engine, or a compiled binary). */
export function isSyncAgents(cmd: readonly string[]): boolean {
  const first = cmd[0] ?? "";
  if (/(^|\/)sync-agents$/.test(first) || first === process.env.AGENT_HUB_BINARY) return true;
  return (first === "bun" || first.endsWith("/bun")) && /src\/(cli|mcp-sync)\.ts$/.test(cmd[1] ?? "");
}

/** The hub a `--print-dir` run printed, after validating its output. */
export function printedHub(stdout: string): string {
  const { events } = decodeStream(stdout, "stdout");
  const ev = events.find((e) => e._schema.id === "agent_hub.print_dir");
  if (!ev) throw new Error(`no agent_hub.print_dir line in: ${stdout.slice(0, 300)}`);
  return ev.hub as string;
}
