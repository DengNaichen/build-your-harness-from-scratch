import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_CAP = 400_000;

/**
 * The boundary between "the harness" and "the machine".
 * Every side effect the agent can cause goes through here, which is what makes
 * it possible later to swap this for a sandbox / container / remote host
 * without touching the loop or the tools.
 */
export interface Host {
  root: string;
  run(command: string, opts?: { timeoutMs?: number }): Promise<string>;
  read(p: string): Promise<string>;
  write(p: string, content: string): Promise<string>;
  exists(p: string): Promise<boolean>;
}

/** Resolve a user-supplied path against root, refusing anything that escapes it. */
export function resolveInRoot(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the workspace root: ${p}`);
  }
  return abs;
}

export function createLocalHost(root: string): Host {
  const base = path.resolve(root);

  return {
    root: base,

    async run(command, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 120_000;
      return new Promise<string>((resolve, reject) => {
        const child = spawn("/bin/bash", ["-lc", command], {
          cwd: base,
          env: process.env,
        });

        let stdout = "";
        let stderr = "";
        let killedForTimeout = false;

        const timer = setTimeout(() => {
          killedForTimeout = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout.on("data", (d: Buffer) => {
          if (stdout.length < OUTPUT_CAP) stdout += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
          if (stderr.length < OUTPUT_CAP) stderr += d.toString();
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          const parts = [`exit: ${code ?? "signal"}`];
          if (killedForTimeout) parts.push(`note: killed after ${timeoutMs}ms timeout`);
          parts.push("--- stdout ---", truncate(stdout) || "(empty)");
          if (stderr) parts.push("--- stderr ---", truncate(stderr));
          resolve(parts.join("\n"));
        });
      });
    },

    async read(p) {
      return readFile(resolveInRoot(base, p), "utf8");
    },

    async write(p, content) {
      const abs = resolveInRoot(base, p);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return `wrote ${Buffer.byteLength(content)} bytes to ${p}`;
    },

    async exists(p) {
      try {
        await readFile(resolveInRoot(base, p));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function truncate(s: string): string {
  if (s.length <= OUTPUT_CAP) return s;
  return `${s.slice(0, OUTPUT_CAP)}\n… [output truncated at ${OUTPUT_CAP} chars]`;
}
