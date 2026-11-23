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
import grantSchema from "../schemas/agent_hub.grant.schema.json";
import warningSchema from "../schemas/agent_hub.warning.schema.json";
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
  "agent_hub.warning": warningSchema,
  "agent_hub.grant": grantSchema,
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
  "agent_hub.warning": "warning",
  "agent_hub.grant": "grant",
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
// Any other write failure (a full disk, a bad descriptor) is a failed run: it is reported on the
// other stream if that is still open, and the run exits 1 (see writeFailed).
const state = { closed: { stdout: false, stderr: false }, failed: false, human: false };
let guarded = false;

/** Start a run with both streams open and no write failure (one CLI run per call). */
export function resetOutput(human: boolean): void {
  state.closed.stdout = false;
  state.closed.stderr = false;
  state.failed = false;
  state.human = human;
}

/** True when a write failed for a reason other than a closed pipe. */
export function writeFailed(): boolean {
  return state.failed;
}

function streamFailed(name: "stdout" | "stderr", err: NodeJS.ErrnoException): void {
  state.closed[name] = true;
  if (err.code === "EPIPE") return;
  state.failed = true;
  process.exitCode = 1;
  const other = name === "stdout" ? "stderr" : "stdout";
  if (state.closed[other]) return;
  const event: OutputEvent = {
    stream: other,
    id: "agent_hub.error",
    message: `sync-agents: cannot write to ${name}: ${err.message}`,
    data: { code: "internal", detail: `${err.code ?? "error"} writing ${name}` },
  };
  try {
    process[other].write(`${state.human ? event.message : renderJsonLine(event)}\n`);
  } catch {
    state.closed[other] = true; // nothing more can be reported
  }
}

function guardStreams(): void {
  if (guarded) return;
  guarded = true;
  for (const name of ["stdout", "stderr"] as const) {
    process[name].on("error", (err: NodeJS.ErrnoException) => streamFailed(name, err));
  }
}

/** Write events: JSON Lines by default, each event's message with `human`. */
export function writeEvents(events: readonly OutputEvent[], human: boolean): void {
  guardStreams();
  for (const e of events) {
    if (state.closed[e.stream]) continue;
    const line = human ? e.message : renderJsonLine(e);
    try {
      process[e.stream].write(`${line}\n`);
    } catch (err) {
      streamFailed(e.stream, err as NodeJS.ErrnoException);
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
