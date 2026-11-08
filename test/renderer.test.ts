import assert from "node:assert/strict";
import test from "node:test";

import { compact, createReplRenderer, previewLines, stripFraming } from "../src/renderer/repl.ts";

function capture() {
  const out: string[] = [];
  const renderer = createReplRenderer({ color: false, write: (s) => void out.push(s) });
  return { renderer, text: () => out.join("") };
}

test("short output is shown in full", () => {
  const { lines, hidden } = previewLines("a\nb\nc");
  assert.deepEqual(lines, ["a", "b", "c"]);
  assert.equal(hidden, 0);
});

test("long output is folded to a few lines", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const { lines, hidden } = previewLines(text);

  assert.equal(lines.length, 3);
  assert.equal(hidden, 47);
});

test("compact keeps one-line argument previews short", () => {
  const long = { command: "x".repeat(300) };
  const out = compact(long, 40);
  assert.ok(out.length <= 41, out);
  assert.ok(out.endsWith("…"));
});

test("streamed text is not printed twice", () => {
  const { renderer, text } = capture();
  renderer.beginTurn();
  renderer.onDelta("hello ");
  renderer.onDelta("world");
  renderer.onEvent({ type: "assistant", text: "hello world" });

  assert.equal(text(), "\nhello world\n\n");
});

test("a turn with no streaming prints the assistant block once", () => {
  const { renderer, text } = capture();
  renderer.beginTurn();
  renderer.onEvent({ type: "assistant", text: "plain" });

  assert.equal(text(), "\nplain\n\n");
});

test("tool results are folded into a short block", () => {
  const { renderer, text } = capture();
  const call = { id: "c1", name: "bash", args: { command: "ls" } };

  renderer.beginTurn();
  renderer.onEvent({ type: "tool_start", call });
  const result = ["exit: 0", "--- stdout ---", ...Array.from({ length: 30 }, (_, i) => `f${i}`)].join("\n");
  renderer.onEvent({ type: "tool_end", call, ok: true, ms: 42, result });

  const out = text();
  assert.match(out, /⚙ bash/);
  assert.match(out, /✓ 42ms · exit 0/);
  assert.match(out, /… \+27 行/);
  assert.ok(!out.includes("f20"), "folded lines must not be painted");
  // The exit line and section markers belong to the model, not the human.
  assert.ok(!out.includes("--- stdout ---"));
});

test("framing lines are stripped from the human view only", () => {
  const raw = "exit: 2\n--- stdout ---\nhello\n--- stderr ---\nboom";
  assert.equal(stripFraming(raw), "hello\nboom");
});
