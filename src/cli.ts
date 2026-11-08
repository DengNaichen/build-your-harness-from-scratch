import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import path from "node:path";

import { ContextTracker, describeContext } from "./context.ts";
import { createLocalHost } from "./host.ts";
import { runTurn } from "./loop.ts";
import { createTools } from "./tools.ts";
import type { TranscriptEntry } from "./types.ts";
import { FakeModel } from "./model/fake.ts";
import { OpenAICompatibleModel } from "./model/openai.ts";
import { createReplRenderer } from "./renderer/repl.ts";
import { createTrace, defaultTraceDir, nullTrace } from "./trace.ts";

const SYSTEM_PROMPT = `You are a coding agent working inside a single workspace directory.

Rules:
- Every path you pass to a tool is relative to the workspace root.
- Inspect before you change: read a file before overwriting it.
- Prefer running commands and tests over guessing.
- Keep replies short. The user sees tool output already.`;

const PROMPT = "› ";
const CONTINUATION = "  … ";
const INTERRUPTED = "[interrupted]";

const root = path.resolve(process.env.HARNESS_ROOT ?? process.cwd());
const demo = argv.includes("--demo") || !process.env.HARNESS_API_KEY;
const traceBase = defaultTraceDir();
// Demo mode has no real requests to record. /reset starts a new trace.
const newTrace = () => (demo ? nullTrace : createTrace(traceBase, { root }));
let trace = newTrace();
const model = demo ? demoModel() : realModel();

console.log(`harness G0.1 · root=${root}`);
console.log(`model: ${demo ? "fake (offline demo)" : process.env.HARNESS_MODEL ?? "deepseek-chat"}`);
if (!demo) console.log(`trace: ${traceBase}  (另开终端: npm run view)`);

const host = createLocalHost(root);
const tools = createTools(host);

// Project context is re-read at the start of every turn, so editing AGENTS.md
// takes effect on your next message instead of on the next restart. It describes
// the workspace, not the conversation, so /reset leaves it alone. No AGENTS.md
// means an identical prompt to the one this harness sent before the feature.
const context = new ContextTracker(host, SYSTEM_PROMPT, "");
let reloads = 0;

async function reloadContext(): Promise<void> {
  try {
    if (!(await context.refresh())) return; // unchanged: say nothing, send the same bytes
    console.log(describeContext(context.result) + (reloads++ ? "  ← reloaded" : ""));
  } catch (err) {
    // A broken or unreadable context file must never be the reason a session dies.
    console.log(`context: FAILED to reload (${err instanceof Error ? err.message : String(err)}) — still using the previous one`);
  }
}

await reloadContext();
console.log('enter 发送 · 行尾 \\ 续行 · /reset 清空历史 · Ctrl-C 中断当前回合 · exit 退出\n');

const transcript: TranscriptEntry[] = [];
const renderer = createReplRenderer();
const terminal = stdin.isTTY === true;

const rl = createInterface({ input: stdin, output: stdout, terminal });
let controller: AbortController | null = null;

rl.on("SIGINT", () => {
  if (controller) {
    controller.abort();
  } else {
    stdout.write("\n");
    rl.close();
  }
});

if (terminal) {
  rl.setPrompt(PROMPT);
  rl.prompt();
}

let buffer = "";

for await (const raw of rl) {
  const line = raw.replace(/\r$/, "");

  // Multiline: a trailing backslash keeps reading.
  if (line.endsWith("\\")) {
    buffer += `${line.slice(0, -1)}\n`;
    if (terminal) {
      rl.setPrompt(CONTINUATION);
      rl.prompt();
    }
    continue;
  }

  const message = buffer + line;
  const wasMultiline = buffer !== "";
  buffer = "";
  if (wasMultiline && terminal) rl.setPrompt(PROMPT);

  if (!message.trim()) {
    if (terminal) rl.prompt();
    continue;
  }
  if (message.trim() === "exit" || message.trim() === "quit") break;
  if (message.trim() === "/reset") {
    transcript.length = 0;
    trace = newTrace();
    console.log("(history cleared)\n");
    if (terminal) rl.prompt();
    continue;
  }

  // Pick up AGENTS.md edits made since the last turn, before the first request
  // of this one — so the prompt is stable for every request inside it.
  await reloadContext();

  transcript.push({ role: "user", content: message });

  controller = new AbortController();
  renderer.beginTurn();
  trace.beginTurn(message);
  try {
    const answer = await runTurn({
      model,
      system: context.systemPrompt,
      tools,
      transcript,
      root,
      signal: controller.signal,
      onDelta: (text) => renderer.onDelta(text),
      onEvent: (event) => renderer.onEvent(event),
    });
    if (answer === INTERRUPTED) stdout.write("\n  ⟂ 已中断\n\n");
    // loop.ts reports "stopped at maxSteps" as a string beginning "[stopped:"
    trace.endTurn(answer === INTERRUPTED ? "interrupted" : answer.startsWith("[stopped:") ? "max_steps" : "answered");
  } catch (err) {
    trace.endTurn("error", err instanceof Error ? err.message : String(err));
    renderer.onError(err);
  } finally {
    controller = null;
    if (terminal) rl.prompt();
  }
}

rl.close();

function realModel() {
  return new OpenAICompatibleModel({
    baseUrl: process.env.HARNESS_BASE_URL ?? "https://api.deepseek.com",
    apiKey: process.env.HARNESS_API_KEY!,
    model: process.env.HARNESS_MODEL ?? "deepseek-chat",
    onRequest: (body) => trace.onRequest(body),
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
