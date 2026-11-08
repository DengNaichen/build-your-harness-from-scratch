/**
 * The three contracts that must not change across generations.
 *
 * Everything else in this repo is allowed to be rewritten by the agent later.
 * These are not. If a future generation wants to change them, it updates
 * CONTRACTS.md and bumps TRANSCRIPT_VERSION — never silently.
 */

/** Bump this when TranscriptEntry changes shape. Old transcripts become unreadable. */
export const TRANSCRIPT_VERSION = 1;

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Already JSON-parsed. The tool is responsible for validating it. */
  args: unknown;
}

export interface TranscriptEntry {
  role: Role;
  content: string;
  /** assistant only: the calls it wants executed before it speaks again */
  toolCalls?: ToolCall[];
  /** tool only: which call this is the answer to */
  toolCallId?: string;
  /** tool only: tool name, for human-readable replay */
  name?: string;
}

/**
 * A tool is a pure-ish function plus a JSON Schema. The loop never special-cases
 * any tool by name — if it isn't in the registry, the model gets an error string.
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. Kept deliberately small to hand-validate. */
  inputSchema: Record<string, unknown>;
  run(args: any, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  root: string;
  /** Present when the turn can be interrupted; long-running tools should honour it. */
  signal?: AbortSignal;
}

export interface ModelRequest {
  system: string;
  messages: TranscriptEntry[];
  tools: Tool[];
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
}

/**
 * Per-call knobs that must not leak into ModelRequest: one is how the human
 * sees the answer, the other is how the human stops it.
 */
export interface CompleteOptions {
  /** Aborting rejects `complete` with an error whose name is "AbortError". */
  signal?: AbortSignal;
  /** Called for every streamed text fragment. Implementations may ignore it. */
  onDelta?: (text: string) => void;
}

/**
 * The only place a model provider touches the rest of the system.
 * Swapping DeepSeek for a local model means writing one more class here.
 */
export interface ModelClient {
  complete(req: ModelRequest, opts?: CompleteOptions): Promise<ModelResponse>;
}
