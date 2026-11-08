import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalHost, resolveInRoot } from "../src/host.ts";
import { runTurn } from "../src/loop.ts";
import { createTools } from "../src/tools.ts";
import type { TranscriptEntry } from "../src/types.ts";
import { FakeModel } from "../src/model/fake.ts";
import type { ScriptedTurn } from "../src/model/fake.ts";

async function harness(script: ScriptedTurn[], maxSteps?: number) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-"));
  const model = new FakeModel(script);
  const tools = createTools(createLocalHost(root));
  const transcript: TranscriptEntry[] = [{ role: "user", content: "go" }];

  const done = async () =>
    await runTurn({ model, system: "test", tools, transcript, root, maxSteps });

  return { root, model, transcript, done };
}

test("a turn ends with the assistant's final text", async () => {
  const h = await harness([
    { toolCalls: [{ name: "bash", args: { command: "echo hello" } }] },
    { text: "all done" },
  ]);

  const out = await h.done();

  assert.equal(out, "all done");
  assert.deepEqual(
    h.transcript.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.match(h.transcript[2].content, /hello/);
  assert.equal(h.transcript[2].toolCallId, h.transcript[1].toolCalls![0].id);
});

test("multiple tool calls in one turn keep their order", async () => {
  const h = await harness([
    {
      toolCalls: [
        { name: "write", args: { path: "notes/a.txt", content: "first\nsecond\n" } },
        { name: "read", args: { path: "notes/a.txt" } },
      ],
    },
    { text: "written and read back" },
  ]);

  await h.done();

  const toolResults = h.transcript.filter((m) => m.role === "tool");
  assert.equal(toolResults.length, 2);
  assert.match(toolResults[0].content, /wrote 13 bytes/);
  assert.match(toolResults[1].content, /1\| first/);
});

test("the model sees the tool result on the next step", async () => {
  const h = await harness([
    { toolCalls: [{ name: "bash", args: { command: "echo SENTINEL_XYZ" } }] },
    { text: "saw it" },
  ]);

  await h.done();

  const second = h.model.requests[1];
  const last = second.messages.at(-1)!;
  assert.equal(last.role, "tool");
  assert.match(last.content, /SENTINEL_XYZ/);
});

test("maxSteps stops a model that never finishes", async () => {
  const looping = { toolCalls: [{ name: "bash", args: { command: "true" } }] };
  const h = await harness([looping, looping, looping, looping], 3);

  const out = await h.done();

  assert.match(out, /maxSteps=3/);
});

test("unknown tools and bad arguments become error results, not crashes", async () => {
  const h = await harness([
    {
      toolCalls: [
        { name: "teleport", args: {} },
        { name: "bash", args: {} },
      ],
    },
    { text: "recovered" },
  ]);

  const out = await h.done();
  const results = h.transcript.filter((m) => m.role === "tool");

  assert.equal(out, "recovered");
  assert.match(results[0].content, /unknown tool "teleport"/);
  assert.match(results[1].content, /missing required property "command"/);
});

test("paths cannot escape the workspace root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-"));
  assert.throws(() => resolveInRoot(root, "../../etc/passwd"), /escapes/);

  const host = createLocalHost(root);
  await assert.rejects(() => host.read("../../etc/passwd"), /escapes/);
});
