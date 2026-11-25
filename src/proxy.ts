import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { PortAuth } from "./provider.ts";

/** The Host the client used. The machine's front proxy gives it to T3, so each client sees its own origin. */
export const CLIENT_HOST_HEADER = "x-t3lizard-host";

export interface Proxy {
  port: number;
  close(): Promise<void>;
}

/**
 * Listen on 127.0.0.1:port and forward HTTP requests and upgrades (WebSocket) to `upstream`,
 * adding the port's access token as `portAuth` says. The local T3 links to this port, so it never
 * sees the token. A token the client sent itself is dropped.
 */
export async function startProxy(opts: { port: number; upstream: URL; accessToken: string; portAuth: PortAuth; extraHosts?: string[] }): Promise<Proxy> {
  const { upstream, accessToken, portAuth } = opts;
  const secure = upstream.protocol === "https:";
  const upstreamPort = Number(upstream.port) || (secure ? 443 : 80);
  const sockets = new Set<Duplex>();
  const authHeader = portAuth.kind === "header" ? portAuth.name.toLowerCase() : undefined;

  const forwardHeaders = (raw: string[]): [string, string][] => {
    const out: [string, string][] = [];
    const cookies: string[] = [];
    let clientHost = "";
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i].toLowerCase();
      if (name === "host") clientHost = raw[i + 1];
      if (name === "host" || name === authHeader || name === CLIENT_HOST_HEADER) continue;
      if (portAuth.kind === "cookie" && name === "cookie") {
        cookies.push(...raw[i + 1].split(";").map((c) => c.trim()).filter((c) => c && c.split("=")[0].trim() !== portAuth.name));
        continue;
      }
      out.push([raw[i], raw[i + 1]]);
    }
    out.push(["Host", upstream.host]);
    if (portAuth.kind === "header") out.push([portAuth.name, accessToken]);
    else out.push(["Cookie", [...cookies, `${portAuth.name}=${accessToken}`].join("; ")]);
    if (clientHost) out.push(["X-T3lizard-Host", clientHost]);
    return out;
  };

  const server = http.createServer((req, res) => {
    const request = secure ? https.request : http.request;
    const up = request(
      {
        hostname: upstream.hostname,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.rawHeaders).flat(),
        servername: secure ? upstream.hostname : undefined,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.rawHeaders);
        upRes.pipe(res);
      },
    );
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`xstack-cloud proxy: ${e.message}`);
    });
    req.pipe(up);
  });

  server.on("upgrade", (req, client: Duplex, head: Buffer) => {
    const up: Duplex = secure
      ? tls.connect({ host: upstream.hostname, port: upstreamPort, servername: upstream.hostname })
      : net.connect({ host: upstream.hostname, port: upstreamPort });
    sockets.add(client).add(up);
    const drop = () => {
      client.destroy();
      up.destroy();
      sockets.delete(client);
      sockets.delete(up);
    };
    client.on("error", drop).on("close", drop);
    up.on("error", drop).on("close", drop);
    up.once(secure ? "secureConnect" : "connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...forwardHeaders(req.rawHeaders).map(([k, v]) => `${k}: ${v}`)];
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      client.pipe(up);
      up.pipe(client);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The same handler on other addresses (the devbox's Tailscale IP), so a browser can open the machine.
  // Best effort: the devbox link only needs 127.0.0.1.
  const extra: http.Server[] = [];
  for (const host of opts.extraHosts ?? []) {
    const s2 = http.createServer((req, res) => server.emit("request", req, res));
    s2.on("upgrade", (req, sock, head) => server.emit("upgrade", req, sock, head));
    s2.on("error", () => {});
    await new Promise<void>((resolve) => {
      s2.once("error", () => resolve());
      s2.listen((server.address() as net.AddressInfo).port, host, () => resolve());
    });
    if (s2.listening) extra.push(s2);
  }

  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        for (const s2 of extra) {
          s2.closeAllConnections();
          s2.close();
        }
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
