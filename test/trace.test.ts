import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTrace, listTraces, listTurns, nullTrace, readTurn } from "../src/trace.ts";

const base = () => path.join(mkdtempSync(path.join(tmpdir(), "trace-")), "traces");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("a trace is trace/turn/request, and request bytes are stored untouched", () => {
  const b = base();
  const t = createTrace(b, { root: "/proj" });
  t.beginTurn("hello");
  t.onRequest('{"step":1}');
  t.onRequest('{"step":2}');
  t.endTurn("answered");
  t.beginTurn("again");
  t.onRequest('{"step":1}');
  t.endTurn("answered");

  const [id] = listTraces(b);
  const dir = path.join(b, id);
  assert.deepEqual(json(path.join(dir, "trace.json")).root, "/proj");
  assert.deepEqual(listTurns(dir), ["turn-001", "turn-002"]);
  assert.deepEqual(readdirSync(path.join(dir, "turn-001")).sort(), ["req-001.json", "req-002.json", "turn.json"]);
  assert.equal(readFileSync(path.join(dir, "turn-001", "req-002.json"), "utf8"), '{"step":2}');
  // numbering restarts for every turn
  assert.deepEqual(readdirSync(path.join(dir, "turn-002")).sort(), ["req-001.json", "turn.json"]);
});

test("turn.json says running from the start and is finalised at the end", () => {
  const b = base();
  const t = createTrace(b, { root: "/p" });
  t.beginTurn("do it");
  const [id] = listTraces(b);
  const file = path.join(b, id, "turn-001", "turn.json");

  assert.equal(json(file).outcome, "running");
  assert.equal(json(file).user, "do it");
  assert.equal(json(file).endedAt, undefined);

  t.onRequest("{}");
  t.endTurn("error", "HTTP 500");
  const done = json(file);
  assert.equal(done.outcome, "error");
  assert.equal(done.error, "HTTP 500");
  assert.equal(done.steps, 1);
  assert.ok(done.endedAt);
});

test("a crash mid-turn leaves the turn marked running", () => {
  const b = base();
  const t = createTrace(b, { root: "/p" });
  t.beginTurn("x");
  t.onRequest("{}");
  // process dies here: endTurn never called
  const [id] = listTraces(b);
  const { record, requests } = readTurn(path.join(b, id, "turn-001"));
  assert.equal(record?.outcome, "running");
  assert.equal(requests.length, 1);
});

test("each trace gets its own directory, even in the same millisecond", () => {
  const b = base();
  const fixed = () => new Date("2026-11-08T10:00:00.000Z");
  for (let i = 0; i < 3; i++) {
    const t = createTrace(b, { root: "/p", now: fixed });
    t.beginTurn("x");
  }
  const ids = listTraces(b);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], "2026-11-08T10-00-00-000");
  assert.deepEqual(ids, [...ids].sort());
});

test("no directory is created until the first turn begins", () => {
  const b = base();
  createTrace(b, { root: "/p" });
  assert.deepEqual(listTraces(b), []);
});

test("a request outside any turn is ignored, and tracing never throws", () => {
  const b = base();
  const t = createTrace(b, { root: "/p" });
  t.onRequest("{}");
  assert.deepEqual(listTraces(b), []);

  // base path is a file: writes must fail, but the agent must not
  const bad = createTrace(path.join(mkdtempSync(path.join(tmpdir(), "x-")), "f", "traces"), { root: "/p" });
  const realError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => {
      bad.beginTurn("x");
      bad.onRequest("{}");
      bad.endTurn("answered");
    });
  } finally {
    console.error = realError;
  }
});

test("nullTrace accepts everything and records nothing", () => {
  nullTrace.beginTurn("x");
  nullTrace.onRequest("{}");
  nullTrace.endTurn("answered");
});
