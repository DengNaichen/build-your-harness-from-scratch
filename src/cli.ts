import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import path from "node:path";

import { createLocalHost } from "./host.ts";
import { runTurn } from "./loop.ts";
import { createTools } from "./tools.ts";
import type { TranscriptEntry } from "./types.ts";
import { FakeModel } from "./model/fake.ts";
import { OpenAICompatibleModel } from "./model/openai.ts";

const SYSTEM_PROMPT = `You are a coding agent working inside a single workspace directory.

Rules:
- Every path you pass to a tool is relative to the workspace root.
- Inspect before you change: read a file before overwriting it.
- Prefer running commands and tests over guessing.
- Keep replies short. The user sees tool output already.`;

const root = path.resolve(process.env.HARNESS_ROOT ?? process.cwd());
const demo = argv.includes("--demo") || !process.env.HARNESS_API_KEY;

const model = demo ? demoModel() : realModel();

console.log(`harness G0 · root=${root}`);
console.log(`model: ${demo ? "fake (offline demo)" : `${process.env.HARNESS_MODEL ?? "deepseek-chat"}`}`);
console.log('type a message, "/reset" to clear history, "exit" to quit\n');

const host = createLocalHost(root);
const tools = createTools(host);
const transcript: TranscriptEntry[] = [];
const rl = createInterface({ input: stdin, output: stdout });

for await (const raw of rl) {
  const line = raw.trim();
  if (!line) continue;
  if (line === "exit" || line === "quit") break;
  if (line === "/reset") {
    transcript.length = 0;
    console.log("(history cleared)\n");
    continue;
  }

  transcript.push({ role: "user", content: line });

  try {
    await runTurn({
      model,
      system: SYSTEM_PROMPT,
      tools,
      transcript,
      root,
      onEvent: (e) => {
        if (e.type === "assistant") {
          console.log(`\n${e.text}\n`);
        } else if (e.type === "tool_start") {
          console.log(`  ⚙ ${e.call.name} ${preview(e.call.args)}`);
        } else {
          console.log(`    ${e.ok ? "✓" : "✗"} ${e.ms}ms`);
        }
      },
    });
  } catch (err) {
    console.error(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

rl.close();

function realModel() {
  return new OpenAICompatibleModel({
    baseUrl: process.env.HARNESS_BASE_URL ?? "https://api.deepseek.com",
    apiKey: process.env.HARNESS_API_KEY!,
    model: process.env.HARNESS_MODEL ?? "deepseek-chat",
  });
}

function demoModel() {
  return new FakeModel([
    { toolCalls: [{ name: "bash", args: { command: "ls -la" } }] },
    {
      text:
        "这就是完整的一轮：我说要跑 `ls -la`，harness 执行后把结果塞回对话，我再基于结果说话。\n" +
        "设置 HARNESS_API_KEY 之后，这里换成真模型，其余代码一行不变。",
    },
  ]);
}

function preview(args: unknown): string {
  const s = JSON.stringify(args ?? {});
  return s.length > 110 ? `${s.slice(0, 110)}…` : s;
}
