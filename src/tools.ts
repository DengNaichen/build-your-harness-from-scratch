import type { Host } from "./host.ts";
import type { Tool } from "./types.ts";

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 30_000;

/**
 * Four tools, deliberately orthogonal. `edit` arrived once whole-file `write`
 * proved painful and silently lossy (see lessons/01-edit.md). `glob` / `grep`
 * wait for the same kind of evidence.
 */
export function createTools(host: Host): Tool[] {
  return [bashTool(host), readTool(host), writeTool(host), editTool(host)];
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
    async run(args, ctx) {
      return host.run(String(args.command), {
        timeoutMs: Number(args.timeout_ms) || undefined,
        signal: ctx.signal,
      });
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

function editTool(host: Host): Tool {
  return {
    name: "edit",
    description:
      "Replace one exact piece of text in an existing file, relative to the workspace root. " +
      "Use it for targeted changes; use write to create a file or rewrite it entirely. " +
      "old_string must match the file character for character, and must be unique in it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        old_string: {
          type: "string",
          description:
            "The exact text to replace, including whitespace and newlines. " +
            "It must occur exactly once in the file: include surrounding lines if needed.",
        },
        new_string: { type: "string", description: "The text to put in its place. May be empty to delete." },
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence instead of requiring a unique match. " +
            "Only set it when you really mean to change all of them.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(args) {
      const filePath = String(args.path);
      const oldString = String(args.old_string);
      const newString = String(args.new_string);
      const replaceAll = args.replace_all === true;

      // An empty string matches everywhere, so it identifies nothing (and would loop forever below).
      if (oldString === "") {
        throw new Error("old_string must not be empty; it identifies the text to replace");
      }
      if (oldString === newString) {
        throw new Error("old_string and new_string are identical; nothing would change");
      }

      let content: string;
      try {
        content = await host.read(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`file not found: ${filePath}; use write to create a new file`);
        }
        throw err;
      }

      const at = content.indexOf(oldString);
      if (at === -1) {
        throw new Error(`old_string not found in ${filePath}; read the file again and copy the text exactly`);
      }

      // Count non-overlapping matches, scanning left to right.
      let count = 0;
      for (let from = at; from !== -1; from = content.indexOf(oldString, from + oldString.length)) {
        count += 1;
      }
      if (count > 1 && !replaceAll) {
        throw new Error(
          `old_string found ${count} matches in ${filePath}; include more surrounding text so it is unique, ` +
            "or set replace_all to change every one",
        );
      }

      // Splice or split/join, never String.replace: it would interpret "$&" and friends in newString.
      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.slice(0, at) + newString + content.slice(at + oldString.length);
      await host.write(filePath, updated);

      const line = content.slice(0, at).split("\n").length;
      return `replaced ${count} occurrence${count === 1 ? "" : "s"} in ${filePath}, first at line ${line}`;
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
