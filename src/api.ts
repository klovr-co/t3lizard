import { chmodSync, existsSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { z } from "zod";
import { ApiError } from "./daemon.ts";
import type { Daemon } from "./daemon.ts";

const id = z.string().min(1);
const routes: Record<string, (d: Daemon, body: unknown) => unknown> = {
  "GET /status": (d) => d.status(),
  "POST /acquire": (d, b) => d.acquire(z.object({ repo: id, ref: id, holder: id }).parse(b)),
  "POST /wait": (d, b) => d.wait(z.object({ ticketId: id, maxSeconds: z.number().min(0).max(300).default(60) }).parse(b)),
  "POST /release": (d, b) =>
    d.release(
      z
        .object({ leaseId: id.optional(), ticketId: id.optional() })
        .refine((r) => r.leaseId || r.ticketId, "give leaseId or ticketId")
        .parse(b),
    ),
  "POST /renew": (d, b) => d.renew(z.object({ leaseId: id }).parse(b)),
  "POST /connect": (d, b) => d.connect(z.object({ machineId: id.optional() }).parse(b)),
  "POST /close": (d, b) => d.close(z.object({ machineId: id }).parse(b)),
  "POST /setup/add": (d, b) => d.setupAdd(z.object({ repo: id, line: id, reason: id, by: id.optional() }).parse(b)),
  "POST /setup/show": (d, b) => d.setupShow(z.object({ repo: id }).parse(b)),
  "POST /setup/remove": (d, b) => d.setupRemove(z.object({ repo: id, step: z.number().int().positive(), by: id.optional() }).parse(b)),
};

export async function serveApi(daemon: Daemon, socketPath: string): Promise<http.Server> {
  if (Buffer.byteLength(socketPath) > 107) throw new Error(`socket path is too long for a unix socket (max 107 bytes): ${socketPath}; use a shorter T3LIZARD_HOME`);
  if (existsSync(socketPath)) {
    if (await answers(socketPath)) throw new Error(`another daemon is already listening on ${socketPath}`);
    unlinkSync(socketPath);
  }
  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return send(404, { error: `no route ${req.method} ${req.url}` });
      let raw = "";
      for await (const chunk of req) raw += chunk;
      send(200, await route(daemon, raw ? JSON.parse(raw) : {}));
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      if (e instanceof z.ZodError || e instanceof SyntaxError) return send(400, { error: e.message });
      send(500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);
  return server;
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

/** One JSON request to the daemon. Throws with the daemon's error message on a non-2xx answer. */
export function call(socketPath: string, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: { "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return reject(new Error(`daemon answered ${res.statusCode}: ${raw.slice(0, 500)}`));
        }
        if ((res.statusCode ?? 500) >= 300) reject(new Error(parsed.error ?? `daemon answered ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? new Error(`t3lizard daemon is not running (no ${socketPath})`) : e),
    );
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
