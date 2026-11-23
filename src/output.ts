/**
 * JSON Lines output contract. Every line sync-agents prints, on stdout and stderr alike, is one
 * JSON object that validates against a schema in schemas/ and names it in `_schema`. `--human`
 * prints each event's `message` instead. Schemas are versioned per message type, independently
 * of the package version.
 */
import { randomBytes } from "node:crypto";
import conflictSchema from "../schemas/agent_hub.conflict.schema.json";
import errorSchema from "../schemas/agent_hub.error.schema.json";
import helpSchema from "../schemas/agent_hub.help.schema.json";
import opSchema from "../schemas/agent_hub.op.schema.json";
import printDirSchema from "../schemas/agent_hub.print_dir.schema.json";
import recoverySchema from "../schemas/agent_hub.recovery.schema.json";
import schemaSchema from "../schemas/agent_hub.schema.schema.json";
import summarySchema from "../schemas/agent_hub.summary.schema.json";
import type { PlannedOp } from "./types.ts";

export const SCHEMAS = {
  "agent_hub.op": opSchema,
  "agent_hub.conflict": conflictSchema,
  "agent_hub.recovery": recoverySchema,
  "agent_hub.summary": summarySchema,
  "agent_hub.error": errorSchema,
  "agent_hub.help": helpSchema,
  "agent_hub.print_dir": printDirSchema,
  "agent_hub.schema": schemaSchema,
} as const;

export type SchemaId = keyof typeof SCHEMAS;

export function schemaVersion(id: SchemaId): string {
  return (SCHEMAS[id] as { "x-schema-version": string })["x-schema-version"];
}

/** One output event; `message` is the human prose, `data` the structured fields. */
export type OutputEvent = {
  stream: "stdout" | "stderr";
  id: SchemaId;
  message: string;
  data: Record<string, unknown>;
};

export const RUN_ID = randomBytes(8).toString("hex");

const KIND: Record<SchemaId, string> = {
  "agent_hub.op": "op",
  "agent_hub.conflict": "conflict",
  "agent_hub.recovery": "recovery",
  "agent_hub.summary": "summary",
  "agent_hub.error": "error",
  "agent_hub.help": "help",
  "agent_hub.print_dir": "print_dir",
  "agent_hub.schema": "schema",
};

export function renderJsonLine(event: OutputEvent, runId: string = RUN_ID): string {
  return JSON.stringify({
    _schema: { id: event.id, version: schemaVersion(event.id) },
    kind: KIND[event.id],
    run_id: runId,
    message: event.message,
    ...event.data,
  });
}

// A reader that stops reading (`| head -1`) closes the pipe. That is not an error of the run: the
// rest of its output is dropped silently, as a prose CLI's would be, and the exit code stands.
const closed = { stdout: false, stderr: false };
let guarded = false;
function guardStreams(): void {
  if (guarded) return;
  guarded = true;
  for (const name of ["stdout", "stderr"] as const) {
    process[name].on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") closed[name] = true;
      else throw err;
    });
  }
}

/** Write events: JSON Lines by default, each event's message with `human`. */
export function writeEvents(events: readonly OutputEvent[], human: boolean): void {
  guardStreams();
  for (const e of events) {
    if (closed[e.stream]) continue;
    const line = human ? e.message : renderJsonLine(e);
    try {
      process[e.stream].write(`${line}\n`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") closed[e.stream] = true;
      else throw err;
    }
  }
}

/** The structured form of a planned or applied operation. */
export function opData(op: PlannedOp): Record<string, unknown> {
  const data: Record<string, unknown> = {
    domain: op.domain,
    action: op.action,
    status: op.status,
    destination: op.destination,
    observed: op.observed,
    intended: op.intended,
    ownership_basis: op.ownershipBasis,
    reason: op.reason,
    target_mutation: op.targetMutation,
    ledger_mutation: op.ledgerMutation,
  };
  if (op.nextStep) data.next_step = op.nextStep;
  return data;
}

/** One event per declared schema, for --schema. */
export function schemaEvents(): OutputEvent[] {
  return (Object.keys(SCHEMAS) as SchemaId[]).map((id) => ({
    stream: "stdout" as const,
    id: "agent_hub.schema" as const,
    message: `${id} ${schemaVersion(id)}`,
    data: { schema_id: id, schema_version: schemaVersion(id), schema: SCHEMAS[id] },
  }));
}
