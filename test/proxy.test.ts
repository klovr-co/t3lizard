import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startProxy } from "../src/proxy.ts";

async function upstream() {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ method: req.method, path: req.url, body }));
    });
  });
  server.on("upgrade", (req, socket, head) => {
    seen.push(req.headers);
    if (req.headers["x-lizard-access-token"] !== "secret") {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: new URL(`http://127.0.0.1:${port}`), seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("forwards an HTTP request with the access token and the upstream host", async (t) => {
  const up = await upstream();
  const proxy = await startProxy({ port: 0, upstream: up.url, accessToken: "secret" });
  t.after(async () => { await proxy.close(); await up.close(); });

  const res = await fetch(`http://127.0.0.1:${proxy.port}/api/x?y=1`, {
    method: "POST",
    body: "hello",
    headers: { "x-lizard-access-token": "client-forged" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-upstream"), "yes");
  assert.deepEqual(await res.json(), { method: "POST", path: "/api/x?y=1", body: "hello" });
  assert.equal(up.seen[0]["x-lizard-access-token"], "secret");
  assert.equal(up.seen[0].host, up.url.host);
});

test("forwards a WebSocket upgrade and relays bytes both ways", async (t) => {
  const up = await upstream();
  const proxy = await startProxy({ port: 0, upstream: up.url, accessToken: "secret" });
  t.after(async () => { await proxy.close(); await up.close(); });

  const sock = net.connect(proxy.port, "127.0.0.1");
  t.after(() => sock.destroy());
  let received = "";
  sock.on("data", (c) => (received += c));
  await new Promise((r) => sock.once("connect", r));
  sock.write(
    "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  await waitFor(() => received.includes("\r\n\r\n"));
  assert.match(received, /^HTTP\/1\.1 101 /);
  sock.write("ping-frame");
  await waitFor(() => received.endsWith("ping-frame"));
  assert.equal(up.seen[0]["x-lizard-access-token"], "secret");
  assert.equal(up.seen[0].upgrade, "websocket");
});

test("answers 502 when the upstream is down", async (t) => {
  const up = await upstream();
  await up.close();
  const proxy = await startProxy({ port: 0, upstream: up.url, accessToken: "secret" });
  t.after(() => proxy.close());
  const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
  assert.equal(res.status, 502);
});

async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "timed out");
}
