/**
 * A local web page for reading traces (see trace.ts). Zero dependencies: a tiny
 * JSON API over the trace directory, plus one static page that polls it.
 *
 *   npm run view            http://127.0.0.1:4317   (HARNESS_VIEW_PORT to change)
 *
 * It only listens on loopback and rejects any other Host header, so a web page
 * you happen to visit cannot read your conversations through DNS rebinding.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  defaultTraceDir,
  listRequests,
  listTraces,
  listTurns,
  readTraceInfo,
  readTurn,
  readTurnRecord,
} from "./trace.ts";

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function createViewServer(base: string): Server {
  return createServer((req, res) => {
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const json = (code: number, value: unknown) => send(code, "application/json", JSON.stringify(value));

    try {
      if (!LOCAL_HOST.test(req.headers.host ?? "")) return json(403, { error: "forbidden host" });
      if (req.method !== "GET") return json(405, { error: "GET only" });

      const parts = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
      if (parts.length === 0) {
        // Read per request so editing the page needs only a browser refresh.
        return send(200, "text/html; charset=utf-8", readFileSync(path.join(import.meta.dirname, "view.html"), "utf8"));
      }
      if (parts[0] !== "api" || parts[1] !== "traces") return json(404, { error: "not found" });

      const ids = listTraces(base);
      if (parts.length === 2) {
        return json(
          200,
          [...ids].reverse().map((id) => ({
            id,
            ...readTraceInfo(path.join(base, id)),
            turns: listTurns(path.join(base, id)).length,
          })),
        );
      }

      // Only names we listed ourselves ever reach the filesystem.
      const id = parts[2];
      if (!ids.includes(id)) return json(404, { error: "no such trace" });
      const dir = path.join(base, id);
      const turns = listTurns(dir);

      if (parts.length === 3) {
        return json(200, {
          id,
          info: readTraceInfo(dir),
          turns: turns.map((name) => ({
            name,
            record: readTurnRecord(path.join(dir, name)),
            steps: listRequests(path.join(dir, name)).length,
          })),
        });
      }

      if (parts.length === 5 && parts[3] === "turns" && turns.includes(parts[4])) {
        const { record, requests } = readTurn(path.join(dir, parts[4]));
        return json(200, {
          name: parts[4],
          record,
          requests: requests.map((body) => {
            try {
              return JSON.parse(body);
            } catch {
              return { unparseable: body };
            }
          }),
        });
      }
      return json(404, { error: "not found" });
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.HARNESS_VIEW_PORT ?? 4317);
  const base = defaultTraceDir();
  const server = createViewServer(base);
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `port ${port} is in use (set HARNESS_VIEW_PORT)` : err.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`traces: ${base}\nopen http://127.0.0.1:${port}`);
  });
}
