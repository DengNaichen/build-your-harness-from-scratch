import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTrace } from "../src/trace.ts";
import { createViewServer } from "../src/view.ts";

async function withServer<T>(fn: (get: (p: string, host?: string) => Promise<{ status: number; body: string }>) => Promise<T>) {
  const base = path.join(mkdtempSync(path.join(tmpdir(), "view-")), "traces");
  const t = createTrace(base, { root: "/proj" });
  t.beginTurn("hello");
  t.onRequest('{"messages":[{"role":"user","content":"hi"}],"tools":[]}');
  t.endTurn("answered");

  const server = createViewServer(base);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  // node:http, not fetch: fetch forbids overriding the Host header
  const get = (p: string, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: p, headers: { host } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    return await fn(get);
  } finally {
    server.close();
  }
}

test("serves the page and the trace → turn → request API", () =>
  withServer(async (get) => {
    assert.match((await get("/")).body, /<html/i);

    const traces = JSON.parse((await get("/api/traces")).body);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].root, "/proj");
    assert.equal(traces[0].turns, 1);

    const trace = JSON.parse((await get(`/api/traces/${traces[0].id}`)).body);
    assert.equal(trace.turns[0].name, "turn-001");
    assert.equal(trace.turns[0].record.outcome, "answered");
    assert.equal(trace.turns[0].steps, 1);

    const turn = JSON.parse((await get(`/api/traces/${traces[0].id}/turns/turn-001`)).body);
    assert.equal(turn.requests[0].messages[0].content, "hi");
  }));

test("only listed names reach the filesystem", () =>
  withServer(async (get) => {
    assert.equal((await get("/api/traces/..%2F..%2Fetc")).status, 404);
    assert.equal((await get("/api/traces/nope")).status, 404);
    const [{ id }] = JSON.parse((await get("/api/traces")).body);
    assert.equal((await get(`/api/traces/${id}/turns/..%2F..`)).status, 404);
    assert.equal((await get("/elsewhere")).status, 404);
  }));

test("a foreign Host header is refused (DNS rebinding)", () =>
  withServer(async (get) => {
    assert.equal((await get("/api/traces", "evil.example.com")).status, 403);
    assert.equal((await get("/api/traces", "localhost:4317")).status, 200);
  }));
