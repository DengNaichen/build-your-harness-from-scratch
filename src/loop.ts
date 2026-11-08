import type { ModelClient, Tool, ToolCall, TranscriptEntry } from "./types.ts";

/** Last-resort clamp on a single tool result, so one bad command can't eat the context. */
const MAX_RESULT_CHARS = 16_000;
export const DEFAULT_MAX_STEPS = 40;

export type LoopEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; ok: boolean; ms: number };

export interface RunTurnOptions {
  model: ModelClient;
  system: string;
  tools: Tool[];
  /** Mutated in place: this is the single source of truth for the conversation. */
  transcript: TranscriptEntry[];
  root: string;
  maxSteps?: number;
  onEvent?: (event: LoopEvent) => void;
}

/**
 * The whole harness, minus IO. Read this function first; everything else is detail.
 *
 * Invariant: an assistant entry with toolCalls is always followed by exactly one
 * tool entry per call, in order. Compaction later must preserve that or the
 * provider will reject the history.
 */
export async function runTurn(opts: RunTurnOptions): Promise<string> {
  const { model, system, tools, transcript, root } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const emit = opts.onEvent ?? (() => {});
  const registry = new Map(tools.map((t) => [t.name, t]));

  for (let step = 0; step < maxSteps; step++) {
    const reply = await model.complete({ system, messages: transcript, tools });

    transcript.push({
      role: "assistant",
      content: reply.text,
      ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}),
    });
    if (reply.text) emit({ type: "assistant", text: reply.text });

    // No tool calls means the model is done talking.
    if (reply.toolCalls.length === 0) return reply.text;

    for (const call of reply.toolCalls) {
      emit({ type: "tool_start", call });
      const started = Date.now();
      const { result, ok } = await execute(call, registry, root);
      emit({ type: "tool_end", call, ok, ms: Date.now() - started });

      transcript.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: clamp(result),
      });
    }
  }

  const note = `[stopped: reached maxSteps=${maxSteps} without a final answer]`;
  transcript.push({ role: "assistant", content: note });
  return note;
}

async function execute(
  call: ToolCall,
  registry: Map<string, Tool>,
  root: string,
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
    return { ok: true, result: await tool.run(call.args, { root }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: `error: ${call.name} failed: ${message}` };
  }
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
