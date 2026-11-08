import type { CompleteOptions, ModelClient, ModelRequest, ModelResponse, ToolCall } from "../types.ts";

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; args?: unknown }>;
}

/**
 * A model that reads from a script instead of the network.
 *
 * This is the single most valuable piece of the repo: it makes the entire loop
 * testable for free, offline, deterministically. Every generation must keep it
 * working, or "the new version is better" becomes unfalsifiable.
 */
export class FakeModel implements ModelClient {
  private script: ScriptedTurn[];
  private cursor = 0;
  private seq = 0;
  public readonly requests: ModelRequest[] = [];

  constructor(script: ScriptedTurn[]) {
    this.script = script;
  }

  async complete(req: ModelRequest, opts: CompleteOptions = {}): Promise<ModelResponse> {
    opts.signal?.throwIfAborted();
    this.requests.push({ ...req, messages: [...req.messages] });

    const turn = this.script[this.cursor++] ?? {
      text: "[fake model: script exhausted]",
    };
    const text = turn.text ?? "";

    // Emit the text as one delta so the streaming path is exercised offline too.
    if (text) opts.onDelta?.(text);

    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((c) => ({
      id: `call_${++this.seq}`,
      name: c.name,
      args: c.args ?? {},
    }));

    return { text, toolCalls };
  }
}
