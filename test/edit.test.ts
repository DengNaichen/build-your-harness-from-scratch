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

test("several matches: throws with the count and leaves the file untouched", async () => {
  const original = "let a = 1; \nlet b = 1;\n";
  const { dir, edit, read } = await setup({ "a.ts": original });

  await assert.rejects(
    edit.run({ path: "a.ts", old_string: "= 1", new_string: "= 2" }, { root: dir }),
    /found 2 matches/,
  );
  assert.equal(await read("a.ts"), original);
});

test("empty old_string: throws and leaves the file untouched", async () => {
  const original = "const x = 1;\n";
  const { dir, edit, read } = await setup({ "a.ts": original });

  await assert.rejects(
    edit.run({ path: "a.ts", old_string: "", new_string: "x" }, { root: dir }),
    /must not be empty/,
  );

  assert.equal(await read("a.ts"), original);
});

test("replace_all: changes every match and reports how many", async () => {
  const { dir, edit, read } = await setup({ "a.ts": "let a = 1;\nlet b = 1;\n" });

  const result = await edit.run(
    { path: "a.ts", old_string: "= 1", new_string: "= 2", replace_all: true },
    { root: dir },
  );

  assert.equal(await read("a.ts"), "let a = 2;\nlet b = 2;\n");
  assert.match(String(result), /replaced 2 occurrences/);
});

test("identical strings: throws because nothing would change", async () => {
  const original = "const x = 1;\n";
  const { dir, edit, read } = await setup({ "a.ts": original });

  await assert.rejects(
    edit.run({ path: "a.ts", old_string: "x = 1", new_string: "x = 1" }, { root: dir }),
    /identical/,
  );

  assert.equal(await read("a.ts"), original);
});

test("missing file: throws a readable error that points to write", async () => {
  const { dir, edit } = await setup({});

  await assert.rejects(
    edit.run({ path: "nope.ts", old_string: "a", new_string: "b" }, { root: dir }),
    /file not found: nope\.ts.*write/,
  );
});

test("a path outside the workspace is refused", async () => {
  const { dir, edit } = await setup({});

  await assert.rejects(
    edit.run({ path: "../outside.ts", old_string: "a", new_string: "b" }, { root: dir }),
    /escapes the workspace/,
  );
});

test("empty new_string deletes the matched text", async () => {
  const { dir, edit, read } = await setup({ "a.ts": "const x = 1;\nconst y = 2;\n" });

  await edit.run({ path: "a.ts", old_string: "const y = 2;\n", new_string: "" }, { root: dir });

  assert.equal(await read("a.ts"), "const x = 1;\n");
});

test("dollar sequences in new_string are written literally", async () => {
  const { dir, edit, read } = await setup({ "a.ts": "price = 1;\n" });

  await edit.run({ path: "a.ts", old_string: "1", new_string: "$&$&" }, { root: dir });

  assert.equal(await read("a.ts"), "price = $&$&;\n");
});

test("CRLF line endings are preserved", async () => {
  const { dir, edit, read } = await setup({ "a.ts": "a = 1;\r\nb = 2;\r\n" });

  await edit.run({ path: "a.ts", old_string: "a = 1", new_string: "a = 10" }, { root: dir });

  assert.equal(await read("a.ts"), "a = 10;\r\nb = 2;\r\n");
});

test("the result tells the model where the change landed", async () => {
  const { dir, edit } = await setup({ "a.ts": "a\nb\nc\n" });

  const result = await edit.run({ path: "a.ts", old_string: "b", new_string: "B" }, { root: dir });

  assert.match(String(result), /replaced 1 occurrence in a\.ts, first at line 2/);
});
