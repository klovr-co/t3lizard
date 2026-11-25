import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy.ts";
// @ts-ignore: plain JS module that runs on the machine
import { clientHost, rewriteHeaders, startFront } from "../src/machine/front.mjs";

const HEADER = { kind: "header", name: "X-Lizard-Access-Token" } as const;

const EDGE_HOST = "example-name-abcd-3774.sandbox.us-east-1.onlizard.com";
const listening = (server: net.Server) => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)));

/**
 * A stand-in for T3: it builds its origin the way the T3 server does (Host, upgraded to https on
 * x-forwarded-proto: https) and, like its DPoP htu check, refuses a request signed for another URL.
 */
async function fakeT3() {
  const seen: http.IncomingHttpHeaders[] = [];
  const origin = (req: http.IncomingMessage) => `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host}`;
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const url = `${origin(req)}${req.url}`;
    if (req.headers["x-signed-htu"] && req.headers["x-signed-htu"] !== url) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `This server only issues tokens for ${origin(req)}/mcp` }));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 300);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ origin: origin(req), url }));
  });
  server.on("upgrade", (req, socket, head) => {
    seen.push(req.headers);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Origin: ${origin(req)}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  const port = await listening(server);
  return { port, seen, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

/** Lizard's edge as seen from the machine: checks the token, routes by Host, adds forwarded headers. */
async function fakeEdge(targetPort: number) {
  const headers = (req: http.IncomingMessage): [string, string][] => {
    const out: [string, string][] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() !== "host") out.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
    return [["Host", EDGE_HOST], ...out, ["X-Forwarded-Proto", "https"], ["X-Forwarded-Host", EDGE_HOST], ["Forwarded", `proto=https;host=${EDGE_HOST}`], ["X-Forwarded-For", "203.0.113.9"]];
  };
  const server = http.createServer((req, res) => {
    if (req.headers["x-lizard-access-token"] !== "secret") return void res.writeHead(401).end();
    const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: headers(req).flat() }, (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.rawHeaders);
      res.flushHeaders();
      upRes.pipe(res);
    });
    req.pipe(up);
  });
  server.on("upgrade", (req, client, head) => {
    if (req.headers["x-lizard-access-token"] !== "secret") return void client.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    const up = net.connect(targetPort, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers(req).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      client.pipe(up);
      up.pipe(client);
    });
    client.on("error", () => up.destroy());
    up.on("error", () => client.destroy());
  });
  const port = await listening(server);
  return { port, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

function hostFile(content?: string) {
  const file = join(mkdtempSync(join(tmpdir(), "t3lizard-front-")), "front-host");
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

/** A raw WebSocket-style upgrade: returns the response head and what the server echoed back. */
function upgrade(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ head: string; echo: string }>((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const lines = Object.entries({ Upgrade: "websocket", Connection: "Upgrade", ...headers }).map(([k, v]) => `${k}: ${v}`);
      s.write(`GET ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (c) => {
      buf += c;
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!buf.startsWith("HTTP/1.1 101")) return (s.destroy(), resolve({ head: buf.slice(0, end), echo: "" }));
      if (buf.length === end + 4) return void s.write("ping-frame");
      if (buf.slice(end + 4) === "ping-frame") (s.destroy(), resolve({ head: buf.slice(0, end), echo: "ping-frame" }));
    });
    s.on("error", reject);
  });
}

test("rewriteHeaders sets Host and drops every origin-moving header and the Lizard token", () => {
  const raw = ["Host", EDGE_HOST, "X-Forwarded-Proto", "https", "x-forwarded-host", EDGE_HOST, "Forwarded", "proto=https", "X-Forwarded-For", "1.2.3.4", "X-Lizard-Access-Token", "secret", "Authorization", "DPoP abc", "DPoP", "proof"];
  assert.deepEqual(rewriteHeaders(raw, "127.0.0.1:47301"), [["Host", "127.0.0.1:47301"], ["Authorization", "DPoP abc"], ["DPoP", "proof"]]);
});

test("the front proxy gives T3 the devbox Host and no forwarded headers or token", async (t) => {
  const t3 = await fakeT3();
  const file = hostFile();
  const front = await startFront({ listenPort: 0, t3Port: t3.port, hostFile: file, listenHost: "127.0.0.1" });
  t.after(async () => (await front.close(), await t3.close()));
  const get = (path = "/api/x") =>
    fetch(`http://127.0.0.1:${front.port}${path}`, {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": EDGE_HOST, forwarded: "proto=https", "x-lizard-access-token": "secret", authorization: "DPoP tok" },
    });

  assert.equal((await get()).status, 503, "answers 503 until bring-up writes the host file");
  writeFileSync(file, "127.0.0.1:47301\n");
  const res = await get();
  assert.deepEqual(await res.json(), { origin: "http://127.0.0.1:47301", url: "http://127.0.0.1:47301/api/x" });
  const seen = t3.seen.at(-1)!;
  assert.equal(seen.host, "127.0.0.1:47301");
  for (const h of ["x-forwarded-proto", "x-forwarded-host", "forwarded", "x-lizard-access-token"]) assert.equal(seen[h], undefined, h);
  assert.equal(seen.authorization, "DPoP tok", "other headers pass through");

  writeFileSync(file, "127.0.0.1:47302\n");
  assert.equal((await (await get()).json()).origin, "http://127.0.0.1:47302", "a new host file applies without a restart");
});

test("the front proxy passes a WebSocket upgrade and streams SSE as it comes", async (t) => {
  const t3 = await fakeT3();
  const front = await startFront({ listenPort: 0, t3Port: t3.port, hostFile: hostFile("127.0.0.1:47301"), listenHost: "127.0.0.1" });
  t.after(async () => (await front.close(), await t3.close()));

  const ws = await upgrade(front.port, "/ws", { Host: EDGE_HOST, "X-Forwarded-Proto": "https", "X-Lizard-Access-Token": "secret" });
  assert.match(ws.head, /^HTTP\/1\.1 101/);
  assert.match(ws.head, /X-Origin: http:\/\/127\.0\.0\.1:47301/);
  assert.equal(ws.echo, "ping-frame");
  assert.equal(t3.seen.at(-1)!["x-lizard-access-token"], undefined);

  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${front.port}/events`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, "data: one\n\n");
  assert.ok(Date.now() - started < 250, "the first event arrives before the stream ends");
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  assert.equal(rest, "data: two\n\n");
});

test("end to end: the devbox client sees and signs for http://127.0.0.1:<port>", async (t) => {
  const t3 = await fakeT3();
  const file = hostFile();
  // The real script, started the way the machine supervisor starts it.
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/machine/front.mjs"), "0", String(t3.port), file]);
  t.after(() => child.kill());
  const frontPort = await new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (c) => {
      const m = String(c).match(/front on :(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.once("exit", (code) => reject(new Error(`front exited ${code}`)));
  });
  const edge = await fakeEdge(frontPort);
  const devbox = await startProxy({ port: 0, upstream: new URL(`http://127.0.0.1:${edge.port}`), accessToken: "secret", portAuth: HEADER });
  t.after(async () => (await devbox.close(), await edge.close(), await t3.close()));
  writeFileSync(file, `127.0.0.1:${devbox.port}\n`); // what bring-up writes (configureFront)

  const base = `http://127.0.0.1:${devbox.port}`;
  const res = await fetch(`${base}/mcp`, { headers: { "x-signed-htu": `${base}/mcp` } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { origin: base, url: `${base}/mcp` });
  const seen = t3.seen.at(-1)!;
  assert.equal(seen.host, `127.0.0.1:${devbox.port}`);
  for (const h of ["x-forwarded-proto", "x-forwarded-host", "forwarded", "x-forwarded-for", "x-lizard-access-token"]) assert.equal(seen[h], undefined, h);

  const ws = await upgrade(devbox.port, "/ws", { Host: `127.0.0.1:${devbox.port}` });
  assert.match(ws.head, new RegExp(`X-Origin: ${base.replace(/\./g, "\\.")}`));
  assert.equal(ws.echo, "ping-frame");
});

test("without the front proxy, T3 sees the onlizard origin: the live-test failure", async (t) => {
  const t3 = await fakeT3();
  const edge = await fakeEdge(t3.port);
  const devbox = await startProxy({ port: 0, upstream: new URL(`http://127.0.0.1:${edge.port}`), accessToken: "secret", portAuth: HEADER });
  t.after(async () => (await devbox.close(), await edge.close(), await t3.close()));
  const base = `http://127.0.0.1:${devbox.port}`;
  const res = await fetch(`${base}/mcp`, { headers: { "x-signed-htu": `${base}/mcp` } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, `This server only issues tokens for https://${EDGE_HOST}/mcp`);
});

test("a browser on another devbox address (Tailscale) gets its own origin, through the same machine", async (t) => {
  const t3 = await fakeT3();
  const file = hostFile();
  const front = await startFront({ listenPort: 0, t3Port: t3.port, hostFile: file, listenHost: "127.0.0.1" });
  const edge = await fakeEdge(front.port);
  const devbox = await startProxy({ port: 0, upstream: new URL(`http://127.0.0.1:${edge.port}`), accessToken: "secret", portAuth: HEADER, extraHosts: ["127.0.0.2"] });
  t.after(async () => (await devbox.close(), await edge.close(), await front.close(), await t3.close()));
  writeFileSync(file, `127.0.0.1:${devbox.port}\n`);

  const local = `http://127.0.0.1:${devbox.port}`;
  assert.deepEqual(await (await fetch(`${local}/mcp`, { headers: { "x-signed-htu": `${local}/mcp` } })).json(), { origin: local, url: `${local}/mcp` });

  const browser = `http://127.0.0.2:${devbox.port}`;
  // A client cannot pick the origin by sending the header itself: the devbox proxy replaces it.
  const res = await fetch(`${browser}/mcp`, { headers: { "x-signed-htu": `${browser}/mcp`, "x-t3lizard-host": "evil.example:1" } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { origin: browser, url: `${browser}/mcp` });
  assert.equal(t3.seen.at(-1)!["x-t3lizard-host"], undefined);
});

test("clientHost takes only host:port", () => {
  assert.equal(clientHost(["X-T3lizard-Host", "devbox.tail.ts.net:47301"]), "devbox.tail.ts.net:47301");
  assert.equal(clientHost(["x-t3lizard-host", "a b:1"]), undefined);
  assert.equal(clientHost(["x-t3lizard-host", "host/path:1"]), undefined);
  assert.equal(clientHost(["host", "x:1"]), undefined);
});
