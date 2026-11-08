import type {
  CompleteOptions,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolCall,
  TranscriptEntry,
} from "../types.ts";

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  /**
   * Sees the exact string about to go on the wire, synchronously, before fetch.
   * It is the same string that is sent — never a second serialisation — so what
   * you inspect is what the provider receives.
   */
  onRequest?: (body: string) => void;
}

/**
 * Streaming client for any OpenAI-compatible /chat/completions endpoint
 * (DeepSeek included). Written by hand on top of fetch so there's no SDK in the
 * dependency tree and no magic between the transcript and the wire.
 */
export class OpenAICompatibleModel implements ModelClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private onRequest?: (body: string) => void;

  constructor(cfg: OpenAIConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.temperature = cfg.temperature ?? 0.7;
    this.onRequest = cfg.onRequest;
  }

  async complete(req: ModelRequest, opts: CompleteOptions = {}): Promise<ModelResponse> {
    const body = JSON.stringify({
      model: this.model,
      stream: true,
      temperature: this.temperature,
      messages: toWire(req.system, req.messages),
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    });
    this.onRequest?.(body);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      signal: opts.signal,
      body,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`model request failed: HTTP ${res.status}\n${text.slice(0, 2000)}`);
    }

    return await readStream(res.body, opts.onDelta);
  }
}

function toWire(system: string, messages: TranscriptEntry[]): unknown[] {
  const wire: unknown[] = [{ role: "system", content: system }];

  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      wire.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });
    } else if (m.role === "tool") {
      wire.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else {
      wire.push({ role: m.role, content: m.content });
    }
  }
  return wire;
}

type Partial = { id?: string; name?: string; args: string };

async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<ModelResponse> {
  const decoder = new TextDecoder();
  const pending = new Map<number, Partial>();
  let text = "";
  let buffer = "";
  let finished = false;

  const handle = (payload: string) => {
    if (payload === "[DONE]") {
      finished = true;
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // ignore keep-alive / malformed frames
    }
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onDelta?.(delta.content);
    }

    for (const tc of delta.tool_calls ?? []) {
      const slot = pending.get(tc.index ?? 0) ?? { args: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      pending.set(tc.index ?? 0, slot);
    }
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
    if (finished) break;
  }

  const toolCalls: ToolCall[] = [...pending.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, p]) => p.name)
    .map(([index, p]) => ({
      id: p.id ?? `call_${index}`,
      name: p.name!,
      args: safeParse(p.args),
    }));

  return { text, toolCalls };
}

function safeParse(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}
