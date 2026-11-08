import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { OpenAICompatibleModel } from "../src/model/openai.ts";
import { createTools } from "../src/tools.ts";
import { createLocalHost } from "../src/host.ts";
import { tmpdir } from "node:os";

/**
 * The SSE parser is the only code that talks to the network, so it gets a fake
 * server instead of a real one. Note the tool_call arguments are deliberately
 * split across two frames — that's the part everyone gets wrong.
 */
test("streams text and reassembles tool_calls split across frames", async () => {
  let received: any;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = [
        { choices: [{ delta: { role: "assistant", content: "Let me " } }] },
        { choices: [{ delta: { content: "check." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_a",
                    type: "function",
                    function: { name: "bash", arguments: '{"comm' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } },
          ],
        },
      ];
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  try {
    const model = new OpenAICompatibleModel({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "sk-test",
      model: "deepseek-chat",
    });
    const tools = createTools(createLocalHost(tmpdir()));

    const reply = await model.complete({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools,
    });

    assert.equal(reply.text, "Let me check.");
    assert.equal(reply.toolCalls.length, 1);
    assert.equal(reply.toolCalls[0].name, "bash");
    assert.equal(reply.toolCalls[0].id, "call_a");
    assert.deepEqual(reply.toolCalls[0].args, { command: "ls" });

    // The request must carry the system prompt and the tool schemas.
    assert.equal(received.messages[0].role, "system");
    assert.equal(received.stream, true);
    assert.deepEqual(
      received.tools.map((t: any) => t.function.name),
      ["bash", "read", "write"],
    );
  } finally {
    server.close();
  }
});

test("surfaces an HTTP error instead of hanging", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":{"message":"bad key"}}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  try {
    const model = new OpenAICompatibleModel({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "sk-bad",
      model: "x",
    });

    await assert.rejects(
      () => model.complete({ system: "s", messages: [], tools: [] }),
      /HTTP 401[\s\S]*bad key/,
    );
  } finally {
    server.close();
  }
});
