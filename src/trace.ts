/**
 * A trace is a write-only record for humans: what the harness sent, grouped the
 * way the conversation actually unfolds.
 *
 *   <base>/<trace-id>/trace.json        which workspace, when it started
 *   <base>/<trace-id>/turn-001/turn.json    the user message and how the turn ended
 *   <base>/<trace-id>/turn-001/req-001.json the exact bytes of one provider request
 *
 * trace  — one transcript's lifetime (a new one starts on /reset)
 * turn   — one runTurn: a user message until the model stops asking for tools
 * request— one model.complete call, i.e. one step of the loop
 *
 * This is NOT session persistence. Nothing here is ever read back to resume a
 * conversation, so it carries no version number and may change shape freely.
 * It also must never take the agent down: every write failure is swallowed.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Outcome = "running" | "answered" | "interrupted" | "max_steps" | "error";

export interface TurnRecord {
  user: string;
  outcome: Outcome;
  steps: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export interface Trace {
  beginTurn(user: string): void;
  /** Pass this to OpenAICompatibleModel's `onRequest`. */
  onRequest(body: string): void;
  endTurn(outcome: Exclude<Outcome, "running">, error?: string): void;
}

export const nullTrace: Trace = { beginTurn() {}, onRequest() {}, endTurn() {} };

/** HARNESS_TRACE_DIR, or .harness/traces inside the harness repo itself. */
export function defaultTraceDir(): string {
  return process.env.HARNESS_TRACE_DIR
    ? path.resolve(process.env.HARNESS_TRACE_DIR)
    : path.resolve(import.meta.dirname, "..", ".harness", "traces");
}

const pad = (n: number) => String(n).padStart(3, "0");

export function createTrace(base: string, opts: { root: string; now?: () => Date }): Trace {
  const now = opts.now ?? (() => new Date());
  let dir: string | null = null; // created lazily, so an idle /reset leaves nothing behind
  let turn = 0;
  let step = 0;
  let turnDir: string | null = null;
  let record: TurnRecord | null = null;
  let warned = false;

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (!warned) console.error(`(trace disabled: ${err instanceof Error ? err.message : err})`);
      warned = true;
    }
  };
  const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2));

  const open = (): string => {
    if (dir) return dir;
    mkdirSync(base, { recursive: true });
    const started = now();
    const stamp = started.toISOString().replace(/[:.]/g, "-").replace("Z", "");
    for (let n = 1; ; n++) {
      const candidate = path.join(base, n === 1 ? stamp : `${stamp}-${n}`);
      try {
        mkdirSync(candidate); // no `recursive`: EEXIST tells us the name is taken
        dir = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    writeJson(path.join(dir, "trace.json"), { root: opts.root, startedAt: started.toISOString() });
    return dir;
  };

  return {
    beginTurn(user) {
      safe(() => {
        const d = open();
        turn += 1;
        step = 0;
        turnDir = path.join(d, `turn-${pad(turn)}`);
        mkdirSync(turnDir);
        // Written up front: a crash leaves "running" behind, which is itself information.
        record = { user, outcome: "running", steps: 0, startedAt: now().toISOString() };
        writeJson(path.join(turnDir, "turn.json"), record);
      });
    },
    onRequest(body) {
      if (!turnDir) return;
      safe(() => {
        step += 1;
        writeFileSync(path.join(turnDir!, `req-${pad(step)}.json`), body);
      });
    },
    endTurn(outcome, error) {
      if (!turnDir || !record) return;
      safe(() => {
        record = { ...record!, outcome, steps: step, endedAt: now().toISOString(), ...(error ? { error } : {}) };
        writeJson(path.join(turnDir!, "turn.json"), record);
      });
      turnDir = null;
      record = null;
    },
  };
}

// ── reading ─────────────────────────────────────────────────────────────────

function names(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir).filter((f) => re.test(f)).sort();
  } catch {
    return [];
  }
}

export const listTraces = (base: string) => names(base, /^\d{4}-/);
export const listTurns = (traceDir: string) => names(traceDir, /^turn-\d+$/);

export const listRequests = (turnDir: string) => names(turnDir, /^req-\d+\.json$/);

export function readTurnRecord(turnDir: string): TurnRecord | null {
  try {
    return JSON.parse(readFileSync(path.join(turnDir, "turn.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readTurn(turnDir: string): { record: TurnRecord | null; requests: string[] } {
  const requests = listRequests(turnDir).map((f) => readFileSync(path.join(turnDir, f), "utf8"));
  return { record: readTurnRecord(turnDir), requests };
}

export function readTraceInfo(traceDir: string): { root?: string; startedAt?: string } {
  try {
    return JSON.parse(readFileSync(path.join(traceDir, "trace.json"), "utf8"));
  } catch {
    return {};
  }
}
