// Run from the repo root:  node lessons/02-context/reload.ts
// Editing AGENTS.md used to require a restart. This script edits the file in the
// middle of a session and shows what the model is sent before and after — and,
// just as important, that a turn which edits nothing re-sends the same bytes.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextTracker, describeContext } from "../../src/context.ts";
import { createLocalHost } from "../../src/host.ts";

const root = await mkdtemp(path.join(tmpdir(), "context-reload-"));
const file = path.join(root, "AGENTS.md");
const host = createLocalHost(root);
const BASE = "You are a coding agent.";

await writeFile(file, "# House rules\n\n- use `npm`\n");

const tracker = new ContextTracker(host, BASE);

// What the model actually receives is the system prompt, so that is what we print.
const show = (label: string, changed: boolean) =>
  console.log(
    `--- ${label} ---\n` +
      `  changed: ${changed}\n` +
      `  ${describeContext(tracker.result)}\n` +
      `  system bytes: ${Buffer.byteLength(tracker.systemPrompt)}\n` +
      `  says "npm":  ${tracker.systemPrompt.includes("use `npm`")}\n` +
      `  says "pnpm": ${tracker.systemPrompt.includes("use `pnpm`")}\n`,
  );

show("turn 1: startup", await tracker.refresh());

console.log("    … the user edits AGENTS.md by hand, no restart …\n");

await writeFile(file, "# House rules\n\n- use `pnpm`, never `npm`\n");
show("turn 2: after the edit", await tracker.refresh());

const settled = tracker.systemPrompt;
show("turn 3: nothing edited", await tracker.refresh());
console.log(`  byte-identical to turn 2: ${tracker.systemPrompt === settled}\n`);

console.log("--- no AGENTS.md at all ---");
await rm(file);
await tracker.refresh();
console.log(`  system equals the bare base prompt: ${tracker.systemPrompt === BASE}`);
console.log(`  ${describeContext(tracker.result)}`);
