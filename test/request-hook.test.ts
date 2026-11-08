import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { OpenAICompatibleModel } from "../src/model/openai.ts";

test("onRequest receives exactly the bytes that go on the wire", async () => {
  let wire = "";
  const server = createServer((req, res) => {
    req.on("data", (d) => (wire += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    let seen = "";
    const model = new OpenAICompatibleModel({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: "sk-secret",
      model: "m",
      onRequest: (b) => (seen = b),
    });
    await model.complete({ system: "SYS", messages: [{ role: "user", content: "hi" }], tools: [] });
    assert.equal(seen, wire);
    assert.ok(!seen.includes("sk-secret"), "the key travels in a header, never in the body");
  } finally {
    server.close();
  }
});
