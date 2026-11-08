import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextTracker, describeContext, formatContext, loadContext } from "../src/context.ts";
import { createLocalHost } from "../src/host.ts";

// Each test gets its own temp workspace, so nothing leaks between them.
async function setup(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "context-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return { root, host: createLocalHost(root) };
}

const paths = (files: { path: string }[]) => files.map((f) => f.path);

test("a workspace without AGENTS.md yields nothing at all", async () => {
  const { host } = await setup({ "src/a.ts": "export const a = 1;\n" });

  const result = await loadContext(host, "");

  assert.deepEqual(result.files, []);
  assert.equal(result.totalBytes, 0);
});

test("only the known names are read, no matter what else is lying around", async () => {
  const { host } = await setup({
    "AGENTS.md": "rules\n",
    "README.md": "not context\n",
    "AGENT.md": "typo, not context\n",
    "docs/AGENTS.md": "sideways, not on the chain\n",
  });

  const result = await loadContext(host, "");

  assert.deepEqual(paths(result.files), ["AGENTS.md"]);
});

test("the chain runs root -> working directory, deeper last", async () => {
  const { host } = await setup({
    "AGENTS.md": "root rules\n",
    "packages/AGENTS.md": "packages rules\n",
    "packages/api/AGENTS.md": "api rules\n",
  });

  const result = await loadContext(host, "packages/api");

  assert.deepEqual(paths(result.files), ["AGENTS.md", "packages/AGENTS.md", "packages/api/AGENTS.md"]);
  assert.match(formatContext(result), /root rules[\s\S]*packages rules[\s\S]*api rules/);
});

test("working in a subdirectory does not pull in sibling projects", async () => {
  const { host } = await setup({
    "AGENTS.md": "root rules\n",
    "packages/api/AGENTS.md": "api rules\n",
    "packages/web/AGENTS.md": "web rules\n",
  });

  const result = await loadContext(host, "packages/api");

  assert.deepEqual(paths(result.files), ["AGENTS.md", "packages/api/AGENTS.md"]);
});

test("both names at one level: AGENTS.md first, then CLAUDE.md", async () => {
  const { host } = await setup({
    "AGENTS.md": "agents\n",
    "CLAUDE.md": "claude\n",
  });

  const result = await loadContext(host, "");

  assert.deepEqual(paths(result.files), ["AGENTS.md", "CLAUDE.md"]);
});

test("a directory on the chain that does not exist contributes nothing", async () => {
  const { host } = await setup({ "AGENTS.md": "root rules\n" });

  const result = await loadContext(host, "not/created/yet");

  assert.deepEqual(paths(result.files), ["AGENTS.md"]);
});

test("a directory outside the root is refused, not silently clamped", async () => {
  const { host } = await setup({ "AGENTS.md": "root rules\n" });

  await assert.rejects(() => loadContext(host, "../elsewhere"), /escapes the workspace root/);
  await assert.rejects(() => loadContext(host, "packages/../../elsewhere"), /escapes the workspace root/);
  await assert.rejects(() => loadContext(host, "/etc"), /escapes the workspace root/);
});

test("trailing slash and a leading ./ name the same directory", async () => {
  const { host } = await setup({ "AGENTS.md": "root\n", "packages/api/AGENTS.md": "api\n" });

  for (const dir of ["packages/api", "packages/api/", "./packages/api", "packages//api"]) {
    assert.deepEqual(paths((await loadContext(host, dir)).files), ["AGENTS.md", "packages/api/AGENTS.md"], dir);
  }
});

test("empty workspace formats to an empty string, not a header", async () => {
  const { host } = await setup({});

  const result = await loadContext(host, "");

  assert.equal(formatContext(result), "");
  assert.equal(describeContext(result), "context: (none)");
});

test("each file is labelled with its path, so the model can cite it", async () => {
  const { host } = await setup({ "AGENTS.md": "use pnpm\n", "packages/api/AGENTS.md": "never log tokens\n" });

  const text = formatContext(await loadContext(host, "packages/api"));

  assert.match(text, /## AGENTS\.md/);
  assert.match(text, /## packages\/api\/AGENTS\.md/);
  assert.match(text, /never log tokens/);
});

test("trailing blank lines in a file do not grow the prompt over time", async () => {
  const { host } = await setup({ "AGENTS.md": "use pnpm\n\n\n" });

  const text = formatContext(await loadContext(host, ""));

  assert.ok(text.endsWith("use pnpm"), JSON.stringify(text.slice(-20)));
});

test("the byte count is what actually goes on the wire", async () => {
  const body = "# rules\n- use pnpm\n";
  const { host } = await setup({ "AGENTS.md": body });

  const result = await loadContext(host, "");

  assert.equal(result.totalBytes, Buffer.byteLength(body));
  // Small files report bytes: "0.0 KB" would read as an empty rulebook.
  assert.match(describeContext(result), /^context: AGENTS\.md \(19 B, sent every request\)$/);
  assert.match(describeContext({ files: result.files, totalBytes: 2048 }), /\(2\.0 KB, sent every request\)/);
});

test("editing a context file between turns reaches the next prompt", async () => {
  const { root, host } = await setup({ "AGENTS.md": "use npm\n" });
  const tracker = new ContextTracker(host, "BASE");
  await tracker.refresh();
  assert.match(tracker.systemPrompt, /use npm/);

  await writeFile(path.join(root, "AGENTS.md"), "use pnpm\n");

  assert.equal(await tracker.refresh(), true);
  assert.match(tracker.systemPrompt, /use pnpm/);
  assert.doesNotMatch(tracker.systemPrompt, /use npm/);
});

test("an untouched workspace re-sends a byte-identical prompt", async () => {
  const { host } = await setup({ "AGENTS.md": "rules\n" });
  const tracker = new ContextTracker(host, "BASE");
  await tracker.refresh();
  const first = tracker.systemPrompt;

  assert.equal(await tracker.refresh(), false);
  assert.equal(tracker.systemPrompt, first);
});

test("a vanished context file gives the base prompt back, welcome message included", async () => {
  const { root, host } = await setup({ "AGENTS.md": "rules\n" });
  const tracker = new ContextTracker(host, "BASE");
  await tracker.refresh();
  assert.notEqual(tracker.systemPrompt, "BASE");

  await rm(path.join(root, "AGENTS.md"));

  assert.equal(await tracker.refresh(), true);
  assert.equal(tracker.systemPrompt, "BASE");
  assert.deepEqual(tracker.result.files, []);
});
