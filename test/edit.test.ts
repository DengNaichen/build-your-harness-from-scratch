import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalHost } from "../src/host.ts";
import { createTools } from "../src/tools.ts"

async function setup(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "edit-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  const edit = createTools(createLocalHost(dir)).find((t) => t.name === "edit");
  assert.ok(edit, "createTools() has no tool named edit")
  return { dir, edit, read: (name: string) => readFile(path.join(dir, name), "utf8") };
}

test("unique match: replaces only that spot, every other byte unchanged", async () => {
  const { dir, edit, read } = await setup({ "a.ts": "const x = 1;\nconst y = 2;\n" });

  const result = await edit.run({ path: "a.ts", old_string: "x = 1", new_string: "x = 10" },
    { root: dir });

  assert.equal(await read("a.ts"), "const x = 10;\nconst y = 2;\n");
  assert.equal(typeof result, "string");
});

test("not found: throws and leaves the file untouched", async () => {
  const original = "const x = 1;\nconst y = 2;\n";
  const { dir, edit, read } = await setup({ "a.ts": original });

  await assert.rejects(
    edit.run({ path: "a.ts", old_string: "z = 3", new_string: "z = 30" }, { root: dir }),
    /not found/,
  );

  assert.equal(await read("a.ts"), original);
});
