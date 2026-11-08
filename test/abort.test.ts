import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalHost } from "../src/host.ts";
import { runTurn } from "../src/loop.ts";
import { createTools } from "../src/tools.ts";
import type { ModelClient, TranscriptEntry } from "../src/types.ts";
import { FakeModel } from "../src/model/fake.ts";

async function setup(script: ConstructorParameters<typeof FakeModel>[0]) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-abort-"));
  return {
    root,
    model: new FakeModel(script),
    tools: createTools(createLocalHost(root)),
    transcript: [{ role: "user", content: "go" }] as TranscriptEntry[],
  };
}

test("aborting mid tool-call still leaves every announced call answered", async () => {
  const h = await setup([
    {
      toolCalls: [
        { name: "bash", args: { command: "sleep 5" } },
        { name: "write", args: { path: "never.txt", content: "x" } },
      ],
    },
  ]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);

  const out = await runTurn({
    model: h.model,
    system: "test",
    tools: h.tools,
    transcript: h.transcript,
    root: h.root,
    signal: controller.signal,
  });

  assert.equal(out, "[interrupted]");

  const assistant = h.transcript.find((m) => m.role === "assistant")!;
  assert.equal(assistant.toolCalls!.length, 2);

  // The invariant: two announced calls, two tool entries, same ids, same order.
  const results = h.transcript.filter((m) => m.role === "tool");
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((r) => r.toolCallId),
    assistant.toolCalls!.map((c) => c.id),
  );
  assert.match(results[0].content, /interrupted/);
  assert.match(results[1].content, /interrupted/);
});

test("aborting while the model is thinking adds nothing to the transcript", async () => {
  const hanging: ModelClient = {
    complete(_req, opts) {
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (opts?.signal?.aborted) return fail();
        opts?.signal?.addEventListener("abort", fail, { once: true });
      });
    },
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const transcript: TranscriptEntry[] = [{ role: "user", content: "go" }];
  const out = await runTurn({
    model: hanging,
    system: "test",
    tools: [],
    transcript,
    root: tmpdir(),
    signal: controller.signal,
  });

  assert.equal(out, "[interrupted]");
  assert.equal(transcript.length, 1);
});

test("deltas arrive before the assistant event, and only once", async () => {
  const h = await setup([{ text: "hello there" }]);
  const chunks: string[] = [];
  const events: string[] = [];

  await runTurn({
    model: h.model,
    system: "test",
    tools: h.tools,
    transcript: h.transcript,
    root: h.root,
    onDelta: (text) => chunks.push(text),
    onEvent: (event) => events.push(event.type),
  });

  assert.deepEqual(chunks, ["hello there"]);
  assert.deepEqual(events, ["assistant"]);
});
