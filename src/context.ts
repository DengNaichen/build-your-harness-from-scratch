import path from "node:path";
import type { Host } from "./host.ts";

/**
 * Project context: files in the workspace that say *how* to work here, folded
 * into the system prompt once per turn.
 *
 * The concatenation is three lines and needs no explanation. The path is the
 * hard part, and it is decided entirely by this file:
 *
 *   - only these names are ever read — the host has no directory listing, so a
 *     file we cannot name is a file we cannot see (see lessons/02-context.md)
 *   - the chain runs root -> working directory, never sideways or upward past
 *     the root, because the root *is* the trust boundary (CONTRACTS.md §3)
 *   - later files are more specific and win on conflict; we never merge or
 *     resolve contradictions, we only fix the order
 */
export const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface ContextFile {
  /** Relative to the workspace root, forward slashes: how the model should cite it. */
  path: string;
  content: string;
  bytes: number;
}

export interface LoadContextResult {
  files: ContextFile[];
  totalBytes: number;
}

/**
 * Collect every context file from `host.root` down to `dir` (inclusive), in
 * cascade order: shallowest first, so the last file read is the most specific.
 *
 * `dir` is relative to the root and may be "" for the root itself. A directory
 * that does not exist simply contributes nothing — loading context must never
 * be the reason a session fails to start.
 */
export async function loadContext(host: Host, dir = ""): Promise<LoadContextResult> {
  const levels = ancestorChain(dir);

  const files: ContextFile[] = [];
  for (const level of levels) {
    for (const name of CONTEXT_FILE_NAMES) {
      const rel = level ? `${level}/${name}` : name;
      if (!(await host.exists(rel))) continue;
      const content = await host.read(rel);
      files.push({ path: rel, content, bytes: Buffer.byteLength(content) });
    }
  }

  return { files, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

/** "" -> [""]; "packages/api" -> ["", "packages", "packages/api"]. */
function ancestorChain(dir: string): string[] {
  // Order matters: normalize first, *then* strip a leading "./". Stripping with
  // /^\.\/?/ would turn "../etc" into "./etc" and hide the escape below.
  const normalized = path.posix
    .normalize(dir.replaceAll("\\", "/"))
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (normalized === "" || normalized === ".") return [""];
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`context directory escapes the workspace root: ${dir}`);
  }
  const parts = normalized.split("/");
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

/**
 * Render the files as one block of text. Empty when there is nothing to say —
 * a workspace without AGENTS.md must produce a byte-identical prompt to one
 * where this feature does not exist.
 */
export function formatContext({ files }: LoadContextResult): string {
  if (files.length === 0) return "";

  const sections = files.map((f) => `## ${f.path}\n\n${f.content.replace(/\s+$/, "")}`);
  const header = [
    "# Workspace context",
    "Files below describe how to work here. They were loaded from the workspace",
    "root down to the current directory; later files are more specific and win",
    "on conflict.",
  ].join("\n");
  return [header, ...sections].join("\n\n");
}

/**
 * The system prompt as it tracks the disk. `refresh()` re-reads the whole chain
 * and rebuilds the prompt *only when the files actually changed* — so a turn that
 * edits nothing re-sends byte-identical text and the prompt cache keeps working.
 *
 * Call it once per turn, never mid-turn: one turn sends a request per tool call,
 * and a prompt that shifts between them would invalidate the cache for no gain.
 * The visible effect: edit AGENTS.md, send your next message, no restart.
 */
export class ContextTracker {
  /** What was loaded most recently. */
  result: LoadContextResult = { files: [], totalBytes: 0 };
  /** Base prompt plus context. Equal to the base prompt when there is no context. */
  systemPrompt: string;

  private readonly host: Host;
  private readonly basePrompt: string;
  private readonly dir: string;
  private block = "";
  private loaded = false;

  // Plain fields, not TS parameter properties: this repo runs under node's
  // strip-only type stripping, which erases types but cannot rewrite syntax.
  constructor(host: Host, basePrompt: string, dir = "") {
    this.host = host;
    this.basePrompt = basePrompt;
    this.dir = dir;
    this.systemPrompt = basePrompt;
  }

  /** Re-read the chain. Returns true when the prompt changed. Throws if a file is unreadable. */
  async refresh(): Promise<boolean> {
    const next = await loadContext(this.host, this.dir);
    const block = formatContext(next);
    if (this.loaded && block === this.block) return false;

    this.loaded = true;
    this.block = block;
    this.result = next;
    this.systemPrompt = [this.basePrompt, block].filter(Boolean).join("\n\n");
    return true;
  }
}

/** One line for the terminal: what got loaded, and how much it costs per request. */
export function describeContext(result: LoadContextResult): string {
  if (result.files.length === 0) return "context: (none)";
  const names = result.files.map((f) => f.path).join(", ");
  // Bytes below 1 KB would all round to "0.0 KB", which reads as "empty" — and a
  // rulebook that looks empty is exactly the thing this line exists to prevent.
  const size = result.totalBytes < 1024 ? `${result.totalBytes} B` : `${(result.totalBytes / 1024).toFixed(1)} KB`;
  return `context: ${names} (${size}, sent every request)`;
}
