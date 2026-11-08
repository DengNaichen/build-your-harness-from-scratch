/** Offline reproduction against the current Host. All descendants exit after 2s. */
import { createLocalHost } from "../../src/host.ts";

const host = createLocalHost(process.cwd());
// `wait` keeps bash alive; sleep inherits its stdout/stderr pipes.
const command = "sleep 2 & wait";

console.log("--- timeout: 100ms; descendant lifetime: 2s ---");
let started = performance.now();
console.log(await host.run(command, { timeoutMs: 100 }));
console.log(`actual wait: ${Math.round(performance.now() - started)}ms`);

console.log("\n--- abort after 100ms; descendant lifetime: 2s ---");
const controller = new AbortController();
started = performance.now();
const timer = setTimeout(() => controller.abort(), 100);
try {
  await host.run(command, { signal: controller.signal });
  console.log("unexpected: returned normally");
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.name : String(err)}`);
  console.log(`actual wait: ${Math.round(performance.now() - started)}ms`);
} finally {
  clearTimeout(timer);
}
