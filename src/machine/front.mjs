// t3lizard machine front proxy. Runs on the Lizard machine, in front of T3 Code. Plain JS, node: modules only.
//
// Usage: node front.mjs <listenPort> <t3Port> <hostFile>
//
// Lizard's edge routes by Host and adds x-forwarded-proto: https, so T3 would compute its origin as
// https://<name>.sandbox...onlizard.com. The devbox links to http://127.0.0.1:<devbox port> through the
// t3lizard proxy, and T3's MCP OAuth (resource) and DPoP (htu) checks need both sides to agree on one
// origin. This proxy makes T3 see the devbox URL: it sets Host to the contents of <hostFile>
// (127.0.0.1:<devbox port>) and drops every header that could move the origin, plus the Lizard token.
// The host file is read per connection, so changing it needs no restart. When the devbox proxy says
// which Host its client used (x-t3lizard-host: a browser on the tailnet), T3 gets that one instead,
// so the browser's own origin checks pass too. Only callers holding the Lizard token reach this.
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const DROP = new Set([
  "host",
  "forwarded",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-forwarded-for",
  "x-real-ip",
  "x-lizard-access-token",
  "x-t3lizard-host",
]);

/** The Host the devbox proxy's client used (x-t3lizard-host), when it looks like host:port. */
export function clientHost(rawHeaders) {
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === "x-t3lizard-host") {
      const v = rawHeaders[i + 1].trim();
      return /^[A-Za-z0-9.-]+:\d{1,5}$/.test(v) ? v : undefined;
    }
  }
  return undefined;
}

/** Raw header pairs with the origin-moving headers removed and Host set to `host`. */
export function rewriteHeaders(rawHeaders, host) {
  const out = [["Host", host]];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (!DROP.has(rawHeaders[i].toLowerCase())) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  }
  return out;
}

export function startFront({ listenPort, t3Port, hostFile, listenHost = "0.0.0.0" }) {
  const target = () => {
    try {
      return readFileSync(hostFile, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const host = target() && (clientHost(req.rawHeaders) ?? target());
    if (!host) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("t3lizard front: not configured yet");
      return;
    }
    const up = http.request(
      { host: "127.0.0.1", port: t3Port, method: req.method, path: req.url, headers: rewriteHeaders(req.rawHeaders, host).flat() },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.rawHeaders);
        res.flushHeaders(); // event streams (SSE) start at once
        upRes.pipe(res);
      },
    );
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`t3lizard front: ${e.message}`);
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  // Long-lived responses (SSE) and slow uploads must not be cut off by the server's defaults.
  server.requestTimeout = 0;
  server.timeout = 0;

  server.on("upgrade", (req, client, head) => {
    const host = target() && (clientHost(req.rawHeaders) ?? target());
    if (!host) {
      client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const up = net.connect({ host: "127.0.0.1", port: t3Port });
    sockets.add(client).add(up);
    const drop = () => {
      client.destroy();
      up.destroy();
      sockets.delete(client);
      sockets.delete(up);
    };
    client.on("error", drop).on("close", drop);
    up.on("error", drop).on("close", drop);
    up.once("connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...rewriteHeaders(req.rawHeaders, host).map(([k, v]) => `${k}: ${v}`)];
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      client.pipe(up);
      up.pipe(client);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [listenPort, t3Port, hostFile] = process.argv.slice(2);
  if (!listenPort || !t3Port || !hostFile) {
    console.error("usage: node front.mjs <listenPort> <t3Port> <hostFile>");
    process.exit(2);
  }
  const front = await startFront({ listenPort: Number(listenPort), t3Port: Number(t3Port), hostFile });
  console.log(`t3lizard front on :${front.port} -> 127.0.0.1:${t3Port}, Host from ${hostFile}`);
}
