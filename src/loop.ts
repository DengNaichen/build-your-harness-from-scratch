import type { ModelClient, Tool, ToolCall, TranscriptEntry } from "./types.ts";

/** Last-resort clamp on a single tool result, so one bad command can't eat the context. */
const MAX_RESULT_CHARS = 16_000;
export const DEFAULT_MAX_STEPS = 40;

export type LoopEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; ok: boolean; ms: number; result: string };

export interface RunTurnOptions {
  model: ModelClient;
  system: string;
  tools: Tool[];
  /** Mutated in place: this is the single source of truth for the conversation. */
  transcript: TranscriptEntry[];
  root: string;
  maxSteps?: number;
  onEvent?: (event: LoopEvent) => void;
  /** Streamed assistant text, forwarded from the model client. */
  onDelta?: (text: string) => void;
  /** Ctrl-C. Aborting mid-turn still leaves a valid transcript (see `interrupted`). */
  signal?: AbortSignal;
}

/**
 * The whole harness, minus IO. Read this function first; everything else is detail.
 *
 * Invariant: an assistant entry with toolCalls is always followed by exactly one
 * tool entry per call, in order. Compaction later must preserve that or the
 * provider will reject the history — and so must an interrupt, which is why
 * aborting fills in the unanswered calls instead of just bailing out.
 */
export async function runTurn(opts: RunTurnOptions): Promise<string> {
  const { model, system, tools, transcript, root, signal } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const emit = opts.onEvent ?? (() => {});
  const registry = new Map(tools.map((t) => [t.name, t]));

  for (let step = 0; step < maxSteps; step++) {
    let reply;
    try {
      reply = await model.complete({ system, messages: transcript, tools }, { signal, onDelta: opts.onDelta });
    } catch (err) {
      // Aborted before the model said anything: nothing to repair.
      if (isAbort(err, signal)) return interrupted(transcript, [], 0);
      throw err;
    }

    transcript.push({
      role: "assistant",
      content: reply.text,
      ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}),
    });
    if (reply.text) emit({ type: "assistant", text: reply.text });

    // No tool calls means the model is done talking.
    if (reply.toolCalls.length === 0) return reply.text;

    const calls = reply.toolCalls;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      emit({ type: "tool_start", call });
      const started = Date.now();

      let outcome: { result: string; ok: boolean };
      try {
        outcome = await execute(call, registry, root, signal);
      } catch (err) {
        if (isAbort(err, signal)) return interrupted(transcript, calls, i);
        throw err;
      }

      emit({ type: "tool_end", call, ok: outcome.ok, ms: Date.now() - started, result: outcome.result });
      transcript.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: clamp(outcome.result),
      });
    }
  }

  const note = `[stopped: reached maxSteps=${maxSteps} without a final answer]`;
  transcript.push({ role: "assistant", content: note });
  return note;
}

/**
 * Keep the transcript legal after a Ctrl-C: every call the assistant announced
 * gets a tool entry, even the ones that never ran.
 */
function interrupted(
  transcript: TranscriptEntry[],
  calls: ToolCall[],
  from: number,
): string {
  for (let i = from; i < calls.length; i++) {
    transcript.push({
      role: "tool",
      toolCallId: calls[i].id,
      name: calls[i].name,
      content: "[interrupted by user]",
    });
  }
  return "[interrupted]";
}

async function execute(
  call: ToolCall,
  registry: Map<string, Tool>,
  root: string,
  signal?: AbortSignal,
): Promise<{ result: string; ok: boolean }> {
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      ok: false,
      result: `error: unknown tool "${call.name}". available: ${[...registry.keys()].join(", ")}`,
    };
  }

  const invalid = validateArgs(tool.inputSchema, call.args);
  if (invalid) return { ok: false, result: `error: invalid arguments for ${call.name}: ${invalid}` };

  try {
    return { ok: true, result: await tool.run(call.args, { root, signal }) };
  } catch (err) {
    // An abort is not a tool failure; let the loop repair the transcript.
    if (isAbort(err, signal)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: `error: ${call.name} failed: ${message}` };
  }
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof err === "object" && err !== null && (err as Error).name === "AbortError";
}

/**
 * Deliberately tiny JSON Schema check: object-ness, required keys, primitive types.
 * Enough to stop the two failure modes that actually happen (missing arg, wrong
 * type); not enough to be a schema library, which is the point.
 */
export function validateArgs(schema: Record<string, unknown>, args: unknown): string | null {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = (schema.required ?? []) as string[];

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `expected an object, got ${Array.isArray(args) ? "array" : typeof args}`;
  }
  const rec = args as Record<string, unknown>;

  for (const key of required) {
    if (rec[key] === undefined || rec[key] === null) return `missing required property "${key}"`;
  }
  for (const [key, spec] of Object.entries(props)) {
    const value = rec[key];
    if (value === undefined || value === null || !spec.type) continue;
    if (!matchesType(spec.type, value)) {
      return `property "${key}" should be ${spec.type}, got ${typeof value}`;
    }
  }
  return null;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function clamp(s: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_RESULT_CHARS)}\n… [result truncated at ${MAX_RESULT_CHARS} chars]`;
}
