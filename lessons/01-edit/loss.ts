// Run from the repo root:  node lessons/01-edit/loss.ts
// A scripted model rewrites the same file twice with `write`. The second call is
// meant to change only `sum`, but the file it sends back has lost `diff`.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalHost } from "../../src/host.ts";
import { runTurn } from "../../src/loop.ts";
import { createTools } from "../../src/tools.ts";
import { FakeModel } from "../../src/model/fake.ts";

const root = await mkdtemp(path.join(tmpdir(), "edit-loss-"));
const tools = createTools(createLocalHost(root));

const before = [
  "export function sum(a: number, b: number) { return a + b; }",
  "export function diff(a: number, b: number) { return a - b; }",
  "",
].join("\n");

const model = new FakeModel([
  { toolCalls: [{ name: "write", args: { path: "math.ts", content: before } }] },
  // meant to change only sum; diff gets lost while re-typing the file
  {
    toolCalls: [
      { name: "write", args: { path: "math.ts", content: "export function sum(a: number, b: number) { return a + b + 1; }\n" } },
    ],
  },
  { text: "done" },
]);

const transcript = [{ role: "user" as const, content: "add one to sum" }];
const answer = await runTurn({ model, system: "demo", tools, transcript, root });

console.log("model said:", answer);
for (const m of transcript.filter((m) => m.role === "tool")) console.log("tool result:", JSON.stringify(m.content));
console.log("--- file after ---\n" + (await readFile(path.join(root, "math.ts"), "utf8")));
