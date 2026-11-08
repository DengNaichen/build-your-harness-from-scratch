// Run from the repo root:  node lessons/02-context/where.ts
// The concatenation of AGENTS.md into the system prompt is trivial. This script
// is about the part that is not: which files, in which order, and what happens
// at the edges of the tree.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describeContext, formatContext, loadContext } from "../../src/context.ts";
import { createLocalHost } from "../../src/host.ts";

const root = await mkdtemp(path.join(tmpdir(), "context-where-"));

const files: Record<string, string> = {
  "AGENTS.md": "Always run `npm test` before saying you are done.",
  "packages/AGENTS.md": "Packages are published independently: bump the version.",
  "packages/api/AGENTS.md": "The API package must never log request bodies.",
  "packages/api/CLAUDE.md": "API: prefer `readFile` from node:fs/promises.",
  "packages/web/AGENTS.md": "The web package is React 19; no class components.",
  "docs/AGENTS.md": "Docs: prose only, no screenshots.", // sideways, not on any chain
  "AGENT.md": "singular: a typo we must not pick up",
};

for (const [name, content] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), content);
}

const host = createLocalHost(root);

console.log("workspace:");
for (const name of Object.keys(files)) console.log(`  ${name}`);
console.log();

for (const dir of ["", "packages", "packages/api", "docs"]) {
  const result = await loadContext(host, dir);
  console.log(`--- working in ${dir === "" ? "<root>" : dir} ---`);
  for (const f of result.files) console.log(`  ${f.path}  (${f.bytes} B)`);
  if (result.files.length === 0) console.log("  (nothing)");
  console.log(`  ${describeContext(result)}`);
  console.log();
}

// The obvious implementation: one fixed path, read from the root.
const naive = await host.exists("AGENTS.md") ? await host.read("AGENTS.md") : "";
const cascade = await loadContext(host, "packages/api");

console.log("--- naive: read AGENTS.md at the root, once ---");
console.log(`  bytes: ${Buffer.byteLength(naive)}`);
console.log(`  contains the api rule: ${naive.includes("never log request bodies")}`);
console.log();
console.log("--- cascade: root -> packages/api ---");
console.log(`  bytes: ${cascade.totalBytes}`);
console.log(`  contains the api rule: ${formatContext(cascade).includes("never log request bodies")}`);
console.log();
console.log("--- what the model actually receives (cascade) ---");
console.log(formatContext(cascade));
