import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { proxyAwareFetch, readBrowserProxySettings } from "../src/proxy.js";

test("readBrowserProxySettings keeps SOCKS5 credentials for Playwright", () => {
  const originalProxyUrl = process.env.MANGABUFF_PROXY_URL;
  const originalProxyOverrideUrl = process.env.MANGABUFF_PROXY_OVERRIDE_URL;
  process.env.MANGABUFF_PROXY_URL = "socks5://user-name:secret-pass@127.0.0.1:1080";
  delete process.env.MANGABUFF_PROXY_OVERRIDE_URL;

  try {
    assert.deepEqual(readBrowserProxySettings(), {
      password: "secret-pass",
      server: "socks5://127.0.0.1:1080",
      username: "user-name",
    });
  } finally {
    restoreEnv("MANGABUFF_PROXY_URL", originalProxyUrl);
    restoreEnv("MANGABUFF_PROXY_OVERRIDE_URL", originalProxyOverrideUrl);
  }
});

test("readBrowserProxySettings prefers the proxy override", () => {
  const originalProxyUrl = process.env.MANGABUFF_PROXY_URL;
  const originalProxyOverrideUrl = process.env.MANGABUFF_PROXY_OVERRIDE_URL;
  process.env.MANGABUFF_PROXY_URL = "http://stale-proxy.example:8000";
  process.env.MANGABUFF_PROXY_OVERRIDE_URL = "socks5://new-user:new-pass@127.0.0.1:1081";

  try {
    assert.deepEqual(readBrowserProxySettings(), {
      password: "new-pass",
      server: "socks5://127.0.0.1:1081",
      username: "new-user",
    });
  } finally {
    restoreEnv("MANGABUFF_PROXY_URL", originalProxyUrl);
    restoreEnv("MANGABUFF_PROXY_OVERRIDE_URL", originalProxyOverrideUrl);
  }
});

test("readBrowserProxySettings can disable a stale proxy with the direct override", () => {
  const originalProxyUrl = process.env.MANGABUFF_PROXY_URL;
  const originalProxyOverrideUrl = process.env.MANGABUFF_PROXY_OVERRIDE_URL;
  process.env.MANGABUFF_PROXY_URL = "http://stale-proxy.example:8000";
  process.env.MANGABUFF_PROXY_OVERRIDE_URL = "direct";

  try {
    assert.equal(readBrowserProxySettings(), undefined);
  } finally {
    restoreEnv("MANGABUFF_PROXY_URL", originalProxyUrl);
    restoreEnv("MANGABUFF_PROXY_OVERRIDE_URL", originalProxyOverrideUrl);
  }
});

test("proxyAwareFetch sends requests through SOCKS5 proxies", async () => {
  const originalProxyUrl = process.env.MANGABUFF_PROXY_URL;
  const targetRequests: Array<{ host: string | undefined; url: string | undefined }> = [];
  const socksEvents: Array<{
    hostname: string;
    password: string;
    port: number;
    username: string;
  }> = [];

  const targetServer = http.createServer((request, response) => {
    targetRequests.push({
      host: request.headers.host,
      url: request.url,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, via: "socks5" }));
  });

  targetServer.listen(0);
  await once(targetServer, "listening");
  const targetPort = (targetServer.address() as net.AddressInfo).port;

  const socksServer = net.createServer((socket) => {
    void handleSocksClient(socket, socksEvents);
  });

  socksServer.listen(0);
  await once(socksServer, "listening");
  const socksPort = (socksServer.address() as net.AddressInfo).port;

  process.env.MANGABUFF_PROXY_URL = `socks5://proxy-user:proxy-pass@127.0.0.1:${socksPort}`;

  try {
    const response = await proxyAwareFetch(`http://localhost:${targetPort}/through-proxy?ok=1`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, via: "socks5" });
    assert.deepEqual(targetRequests, [{ host: `localhost:${targetPort}`, url: "/through-proxy?ok=1" }]);
    assert.deepEqual(socksEvents, [{
      hostname: "localhost",
      password: "proxy-pass",
      port: targetPort,
      username: "proxy-user",
    }]);
  } finally {
    restoreEnv("MANGABUFF_PROXY_URL", originalProxyUrl);
    await Promise.all([
      closeHttpServer(targetServer),
      closeNetServer(socksServer),
    ]);
  }
});

async function handleSocksClient(
  socket: net.Socket,
  socksEvents: Array<{
    hostname: string;
    password: string;
    port: number;
    username: string;
  }>,
): Promise<void> {
  try {
    const greeting = await readExact(socket, 2);
    assert.equal(greeting[0], 0x05);
    const methods = await readExact(socket, greeting[1]);

    assert.ok(methods.includes(0x02));
    socket.write(Buffer.from([0x05, 0x02]));

    const authHead = await readExact(socket, 2);
    assert.equal(authHead[0], 0x01);
    const username = (await readExact(socket, authHead[1])).toString("utf8");
    const [passwordLength] = await readExact(socket, 1);
    const password = (await readExact(socket, passwordLength)).toString("utf8");

    socket.write(Buffer.from([0x01, 0x00]));

    const requestHead = await readExact(socket, 4);
    assert.deepEqual(Array.from(requestHead.slice(0, 3)), [0x05, 0x01, 0x00]);
    assert.equal(requestHead[3], 0x03);

    const [hostnameLength] = await readExact(socket, 1);
    const hostname = (await readExact(socket, hostnameLength)).toString("utf8");
    const portBytes = await readExact(socket, 2);
    const port = portBytes.readUInt16BE(0);

    socksEvents.push({ hostname, password, port, username });

    const upstream = net.connect({ host: hostname, port });
    await once(upstream, "connect");

    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
    socket.pipe(upstream);
    upstream.pipe(socket);
  } catch {
    socket.destroy();
  }
}

async function readExact(socket: net.Socket, size: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  while (total < size) {
    const chunk = socket.read(size - total);

    if (chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.byteLength;
      continue;
    }

    await waitForReadable(socket);
  }

  return Buffer.concat(chunks, size);
}

async function waitForReadable(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before enough data arrived."));
    };
    const cleanup = () => {
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("end", onClose);
    };

    socket.once("readable", onReadable);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onClose);
  });
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeNetServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
