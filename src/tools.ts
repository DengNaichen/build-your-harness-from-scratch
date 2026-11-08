import type { Host } from "./host.ts";
import type { Tool } from "./types.ts";

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 30_000;

/**
 * G0 toolset: three tools, deliberately orthogonal.
 * `edit` / `glob` / `grep` belong to G1 — adding them now would hide the fact
 * that whole-file rewrites are painful, which is exactly the signal that should
 * drive the next generation.
 */
export function createTools(host: Host): Tool[] {
  return [bashTool(host), readTool(host), writeTool(host)];
}

function bashTool(host: Host): Tool {
  return {
    name: "bash",
    description:
      "Run a shell command in the workspace root and return exit code, stdout and stderr. " +
      "Use it to inspect the repo, run tests, and execute code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds. Default 120000." },
      },
      required: ["command"],
    },
    async run(args) {
      return host.run(String(args.command), { timeoutMs: Number(args.timeout_ms) || undefined });
    },
  };
}

function readTool(host: Host): Tool {
  return {
    name: "read",
    description:
      "Read a UTF-8 text file, relative to the workspace root. Returns line-numbered content. " +
      "Use offset/limit to page through large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        offset: { type: "number", description: "1-based first line to return." },
        limit: { type: "number", description: "Maximum number of lines. Default 400." },
      },
      required: ["path"],
    },
    async run(args) {
      const raw = await host.read(String(args.path));
      const all = raw.split("\n");
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Number(args.limit) || MAX_READ_LINES);
      const slice = all.slice(offset - 1, offset - 1 + limit);

      let out = slice.map((line, i) => `${offset + i}| ${line}`).join("\n");
      const remaining = all.length - (offset - 1 + slice.length);
      if (remaining > 0) out += `\n… [${remaining} more lines; use offset=${offset + slice.length}]`;
      if (out.length > MAX_READ_CHARS) {
        out = `${out.slice(0, MAX_READ_CHARS)}\n… [line too long, truncated]`;
      }
      return out;
    },
  };
}

function writeTool(host: Host): Tool {
  return {
    name: "write",
    description:
      "Create or overwrite a text file, relative to the workspace root. Creates parent directories. " +
      "This replaces the whole file — read before writing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
    async run(args) {
      return host.write(String(args.path), String(args.content));
    },
  };
}
