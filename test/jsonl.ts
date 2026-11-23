/**
 * Test-side half of the output contract: every line sync-agents prints must be a JSON object that
 * validates against the schema it names in `_schema`. decodeOutput enforces that (throwing on any
 * non-conforming line) and hands back the human messages, so assertions written against prose keep
 * their meaning while every run also validates the machine contract.
 */
import Ajv2020 from "ajv/dist/2020";
import { runSync as realRunSync } from "../src/cli.ts";
import { renderJsonLine, SCHEMAS, type SchemaId } from "../src/output.ts";

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

/**
 * runSync, checked: every event it produced validates against its schema, the human messages
 * are exactly the events' messages per stream, and the run ends with exactly one summary or
 * error event. Tests import this instead of src/cli.ts's runSync, so in-process runs (recovery,
 * apply failure, locks) are held to the same contract as spawned ones.
 */
export function runSync(...args: Parameters<typeof realRunSync>): ReturnType<typeof realRunSync> {
  const res = realRunSync(...args);
  assertEventContract(res, Boolean(args[0].checkOnly));
  return res;
}

export function assertEventContract(res: ReturnType<typeof realRunSync>, checkOnly = false): void {
  decodeStream(res.events.map((e) => renderJsonLine(e)).join("\n"), "runSync events");
  const msgs = (stream: "stdout" | "stderr") => res.events.filter((e) => e.stream === stream).map((e) => e.message);
  if (JSON.stringify(msgs("stdout")) !== JSON.stringify(res.stdout)) throw new Error("runSync stdout differs from its stdout events");
  if (JSON.stringify(msgs("stderr")) !== JSON.stringify(res.stderr)) throw new Error("runSync stderr differs from its stderr events");
  // Which stream each summary uses (docs/topics/output "How a run ends").
  const SUMMARY_STREAM: Record<string, "stdout" | "stderr"> = {
    in_sync: "stdout",
    planned: "stdout",
    applied: "stdout",
    recovered_in_sync: "stdout",
    pending_recovery: checkOnly ? "stderr" : "stdout",
    out_of_sync: "stderr",
    conflicts: "stderr",
  };
  for (const e of res.events) {
    if (e.id !== "agent_hub.summary") continue;
    const want = SUMMARY_STREAM[String(e.data.status)];
    if (e.stream !== want) throw new Error(`summary ${e.data.status} on ${e.stream}, documented on ${want}`);
    if (e.data.status === "applied") {
      const applied = res.events.filter((x) => x.id === "agent_hub.op" && x.data.phase === "sync").length;
      if (e.data.changes !== applied) throw new Error(`applied summary says ${e.data.changes} change(s); ${applied} were applied`);
    }
  }
  const terminal = res.events.filter((e) => e.id === "agent_hub.summary" || e.id === "agent_hub.error");
  if (terminal.length !== 1 || res.events[res.events.length - 1] !== terminal[0]) {
    throw new Error(
      `runSync must end with exactly one summary or error event; got ${res.events.map((e) => e.id).join(", ")}`,
    );
  }
}
