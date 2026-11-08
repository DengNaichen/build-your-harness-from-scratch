import type { LoopEvent } from "../loop.ts";

/**
 * A plain-text renderer: no alt-screen, no cursor games.
 * The point of this file is that `loop.ts` doesn't know it exists — swap in a
 * full-screen TUI later by writing another `Renderer` and changing one line.
 */

export interface RendererOptions {
  /** Defaults to "on when stdout is a TTY and NO_COLOR is unset". */
  color?: boolean;
  write?: (chunk: string) => void;
}

export interface Renderer {
  /** Called once per turn so the streamed-text state resets. */
  beginTurn(): void;
  /** A streamed fragment of assistant text. */
  onDelta(text: string): void;
  onEvent(event: LoopEvent): void;
  onError(err: unknown): void;
}

const ESC = "\u001b[";
const DIM = 2;
const RED = 31;
const GREEN = 32;
const CYAN = 36;
const BOLD = 1;

export function createReplRenderer(opts: RendererOptions = {}): Renderer {
  const color = opts.color ?? defaultColor();
  const write = opts.write ?? ((chunk: string) => void process.stdout.write(chunk));
  let streamed = false;

  const paint = (s: string, ...codes: number[]): string =>
    color ? `${ESC}${codes.join(";")}m${s}${ESC}0m` : s;

  return {
    beginTurn() {
      streamed = false;
    },

    onDelta(text) {
      if (!streamed) {
        write("\n");
        streamed = true;
      }
      write(text);
    },

    onEvent(event) {
      switch (event.type) {
        case "assistant": {
          // Deltas already painted this text; just close the block.
          write(streamed ? "\n\n" : `\n${event.text}\n\n`);
          streamed = false;
          break;
        }
        case "tool_start": {
          streamed = false;
          const head = `${paint("⚙", CYAN)} ${paint(event.call.name, BOLD)}`;
          write(`\n  ${head} ${paint(compact(event.call.args), DIM)}\n`);
          break;
        }
        case "tool_end": {
          const exit = /^exit:\s*(\S+)/m.exec(event.result)?.[1];
          const meta = [`${event.ms}ms`, exit ? `exit ${exit}` : null].filter(Boolean).join(" · ");
          const mark = event.ok ? paint("✓", GREEN) : paint("✗", RED);
          write(`    ${mark} ${paint(meta, DIM)}\n`);

          const { lines, hidden } = previewLines(stripFraming(event.result));
          for (const line of lines) write(`      ${paint(clip(line), event.ok ? DIM : RED)}\n`);
          if (hidden > 0) write(`      ${paint(`… +${hidden} 行`, DIM)}\n`);
          break;
        }
      }
    },

    onError(err) {
      const message = err instanceof Error ? err.message : String(err);
      write(`\n  ${paint("✗", RED)} ${paint(message, RED)}\n\n`);
    },
  };
}

/**
 * Drop the wire format the model needs but the human doesn't: the exit line is
 * already in the header, and the section markers are just noise.
 */
export function stripFraming(result: string): string {
  return result
    .split("\n")
    .filter((line) => line !== "--- stdout ---" && line !== "--- stderr ---" && !/^exit:\s*\S+$/.test(line))
    .join("\n");
}

/**
 * Keep the human-readable view short. The model still receives the full result;
 * this only decides what gets painted in the terminal.
 */
export function previewLines(
  text: string,
  maxVisible = 8,
  headWhenLong = 3,
): { lines: string[]; hidden: number } {
  const all = text.replace(/\s+$/, "").split("\n");
  if (all.length <= maxVisible) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, headWhenLong), hidden: all.length - headWhenLong };
}

export function compact(args: unknown, max = 96): string {
  const json = JSON.stringify(args ?? {});
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

function clip(line: string, max = 200): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function defaultColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}
