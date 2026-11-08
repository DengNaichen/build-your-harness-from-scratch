// Run from the repo root:  node lessons/02-context/cost.ts
// Context is re-sent with every single request, so its cost is not "how big is
// this file" but "how big, times how many requests". This script prices the two
// obvious strategies against a monorepo-shaped workspace.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadContext } from "../../src/context.ts";
import { createLocalHost } from "../../src/host.ts";

const PACKAGES = 20;
const PACKAGE_RULE_BYTES = 2048;
const ROOT_RULE_BYTES = 1500;
const STEPS_PER_TURN = 5; // one request per step: model calls tools, gets results, asks again

const filler = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `- [${tag}] rule ${i + 1}: keep this line short.`).join("\n");

const root = await mkdtemp(path.join(tmpdir(), "context-cost-"));

await mkdir(root, { recursive: true });
await writeFile(path.join(root, "AGENTS.md"), filler(ROOT_RULE_BYTES / 40 | 0, "root").padEnd(ROOT_RULE_BYTES, "."));

const names = Array.from({ length: PACKAGES }, (_, i) => `pkg-${String(i).padStart(2, "0")}`);
for (const name of names) {
  await mkdir(path.join(root, "packages", name), { recursive: true });
  await writeFile(
    path.join(root, "packages", name, "AGENTS.md"),
    filler(PACKAGE_RULE_BYTES / 40 | 0, name).padEnd(PACKAGE_RULE_BYTES, "."),
  );
}

const host = createLocalHost(root);

// Strategy A: everything we can find, every time. Requires a directory walk.
async function eagerBytes(dir = "", found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) await eagerBytes(rel, found);
    else if (entry.name === "AGENTS.md" || entry.name === "CLAUDE.md") found.push(rel);
  }
  return found;
}

const all = await eagerBytes();
const eager = (await Promise.all(all.map((p) => host.read(p)))).reduce((n, s) => n + Buffer.byteLength(s), 0);

// Strategy B: only the chain that leads to the directory we are working in.
const cascade = await loadContext(host, `packages/${names[6]}`);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

console.log(`workspace: ${PACKAGES} packages under packages/, each with its own AGENTS.md`);
console.log(`files on disk: ${all.length} (1 root + ${PACKAGES} packages)`);
console.log(`root AGENTS.md: ${ROOT_RULE_BYTES} B, each package AGENTS.md: ${PACKAGE_RULE_BYTES} B`);
console.log();
console.log(`A. eager   : ${all.length} files, ${kb(eager)} per request`);
console.log(`B. cascade : ${cascade.files.length} files, ${kb(cascade.totalBytes)} per request`);
console.log(`   difference: ${(eager / cascade.totalBytes).toFixed(1)}x`);
console.log();
console.log(`per turn (${STEPS_PER_TURN} steps, one request each):`);
console.log(`A. eager   : ${kb(eager * STEPS_PER_TURN)}`);
console.log(`B. cascade : ${kb(cascade.totalBytes * STEPS_PER_TURN)}`);
console.log();
console.log(`of A's ${kb(eager)}, how much can the model act on right now?`);
const relevant = cascade.totalBytes;
console.log(`  ${kb(relevant)} (${((relevant / eager) * 100).toFixed(0)}%) — the rest describes packages it is not touching.`);
