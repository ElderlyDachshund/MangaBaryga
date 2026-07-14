import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const maxRedirects = 5;
const redirectStatusCodes = new Set([301, 302, 303, 307, 308]);
const supportedProxyProtocols = new Set(["http:", "https:", "socks5:"]);
const supportedTargetProtocols = new Set(["http:", "https:"]);

export interface BrowserProxySettings {
  server: string;
  username?: string;
  password?: string;
}

export function readMangabuffProxyUrl(): string | undefined {
  const value =
    process.env.MANGABUFF_PROXY_OVERRIDE_URL?.trim() ||
    process.env.MANGABUFF_PROXY_URL?.trim();
  return value ? value : undefined;
}

export function readBrowserProxySettings(): BrowserProxySettings | undefined {
  const proxyUrl = readMangabuffProxyUrl();

  if (!proxyUrl) {
    return undefined;
  }

  const proxy = parseProxyUrl(proxyUrl);

  return {
    password: proxy.password || undefined,
    server: `${proxy.protocol}//${proxy.hostname}:${proxy.port}`,
    username: proxy.username || undefined,
  };
}

export async function proxyAwareFetch(
  input: string,
  init: RequestInit & {
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const proxyUrl = readMangabuffProxyUrl();

  if (!proxyUrl) {
    return fetch(input, init);
  }

  return fetchViaProxy(input, init, proxyUrl, 0);
}

async function fetchViaProxy(
  input: string,
  init: RequestInit,
  proxyUrl: string,
  redirectCount: number,
): Promise<Response> {
  if (redirectCount > maxRedirects) {
    throw new Error(`Proxy fetch exceeded redirect limit for ${input}.`);
  }

  const targetUrl = new URL(input);
  assertSupportedTargetProtocol(targetUrl);
  const proxy = parseProxyUrl(proxyUrl);
  const method = (init.method ?? "GET").toUpperCase();
  const bodyBuffer = await readRequestBody(init.body);
  const signal = init.signal ?? undefined;
  const response = proxy.protocol === "socks5:"
    ? await requestViaSocksProxy(targetUrl, proxy, method, init.headers, bodyBuffer, signal)
    : targetUrl.protocol === "https:"
      ? await requestHttpsOverProxy(targetUrl, proxy, method, init.headers, bodyBuffer, signal)
      : await requestHttpOverProxy(targetUrl, proxy, method, init.headers, bodyBuffer, signal);

  if (shouldRedirect(response.statusCode, method)) {
    const location = response.headers.get("location");

    if (location) {
      const nextUrl = new URL(location, targetUrl).toString();
      const nextMethod = response.statusCode === 303 ? "GET" : method;
      const nextBody = nextMethod === "GET" ? undefined : toArrayBuffer(bodyBuffer);
      const nextHeaders = new Headers(init.headers);

      if (nextMethod === "GET") {
        nextHeaders.delete("content-type");
        nextHeaders.delete("content-length");
      }

      return fetchViaProxy(
        nextUrl,
        {
          ...init,
          body: nextBody,
          headers: nextHeaders,
          method: nextMethod,
        },
        proxyUrl,
        redirectCount + 1,
      );
    }
  }

  return new Response(new Uint8Array(response.body), {
    headers: response.headers,
    status: response.statusCode,
    statusText: response.statusMessage,
  });
}

function requestViaSocksProxy(
  targetUrl: URL,
  proxy: URL,
  method: string,
  headers: HeadersInit | undefined,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
): Promise<ProxyHttpResponse> {
  return targetUrl.protocol === "https:"
    ? requestHttpsViaSocksProxy(targetUrl, proxy, method, headers, body, signal)
    : requestHttpViaSocksProxy(targetUrl, proxy, method, headers, body, signal);
}

async function requestHttpsViaSocksProxy(
  targetUrl: URL,
  proxy: URL,
  method: string,
  headers: HeadersInit | undefined,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
): Promise<ProxyHttpResponse> {
  const socket = await openSocksProxyConnection(proxy, targetUrl, signal);

  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      ALPNProtocols: ["http/1.1"],
      host: targetUrl.hostname,
      port: Number(targetUrl.port || 443),
      servername: targetUrl.hostname,
      socket,
    });

    secureSocket.once("error", reject);

    const request = https.request({
      createConnection: () => secureSocket,
      headers: normalizeRequestHeaders(headers, body, targetUrl),
      host: targetUrl.hostname,
      method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      port: Number(targetUrl.port || 443),
      protocol: "https:",
      signal,
    });

    attachRequestLifecycle(request, body, targetUrl, resolve, reject);
  });
}

async function requestHttpViaSocksProxy(
  targetUrl: URL,
  proxy: URL,
  method: string,
  headers: HeadersInit | undefined,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
): Promise<ProxyHttpResponse> {
  const socket = await openSocksProxyConnection(proxy, targetUrl, signal);

  return new Promise((resolve, reject) => {
    const request = http.request({
      createConnection: () => socket,
      headers: normalizeRequestHeaders(headers, body, targetUrl),
      host: targetUrl.hostname,
      method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      port: Number(targetUrl.port || 80),
      protocol: "http:",
      signal,
    });

    attachRequestLifecycle(request, body, targetUrl, resolve, reject);
  });
}

function requestHttpsOverProxy(
  targetUrl: URL,
  proxy: URL,
  method: string,
  headers: HeadersInit | undefined,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
): Promise<ProxyHttpResponse> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const connectModule = proxy.protocol === "https:" ? https : http;
    const connectHeaders: Record<string, string> = {
      host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
    };
    const proxyAuthorization = buildProxyAuthorizationHeader(proxy);

    if (proxyAuthorization) {
      connectHeaders["proxy-authorization"] = proxyAuthorization;
    }

    const connectRequest = connectModule.request({
      headers: connectHeaders,
      host: proxy.hostname,
      method: "CONNECT",
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      port: proxyPort,
      signal,
    });

    connectRequest.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with status ${response.statusCode ?? 0}.`));
        return;
      }

      const secureSocket = tls.connect({
        ALPNProtocols: ["http/1.1"],
        host: targetUrl.hostname,
        port: Number(targetUrl.port || 443),
        servername: targetUrl.hostname,
        socket,
      });

      secureSocket.once("error", reject);

      const request = https.request({
        createConnection: () => secureSocket,
        headers: normalizeRequestHeaders(headers, body, targetUrl),
        host: targetUrl.hostname,
        method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        port: Number(targetUrl.port || 443),
        protocol: "https:",
        signal,
      });

      attachRequestLifecycle(request, body, targetUrl, resolve, reject);
    });

    connectRequest.once("error", reject);
    connectRequest.end();
  });
}

function requestHttpOverProxy(
  targetUrl: URL,
  proxy: URL,
  method: string,
  headers: HeadersInit | undefined,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
): Promise<ProxyHttpResponse> {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const requestModule = proxy.protocol === "https:" ? https : http;
    const requestHeaders = normalizeRequestHeaders(headers, body, targetUrl);
    const proxyAuthorization = buildProxyAuthorizationHeader(proxy);

    if (proxyAuthorization) {
      requestHeaders["proxy-authorization"] = proxyAuthorization;
    }

    const request = requestModule.request({
      headers: requestHeaders,
      host: proxy.hostname,
      method,
      path: targetUrl.toString(),
      port: proxyPort,
      protocol: proxy.protocol,
      signal,
    });

    attachRequestLifecycle(request, body, targetUrl, resolve, reject);
  });
}

function attachRequestLifecycle(
  request: http.ClientRequest,
  body: Buffer | undefined,
  targetUrl: URL,
  resolve: (value: ProxyHttpResponse | PromiseLike<ProxyHttpResponse>) => void,
  reject: (reason?: unknown) => void,
): void {
  request.once("response", (response) => {
    const chunks: Buffer[] = [];

    response.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    response.once("end", () => {
      resolve({
        body: Buffer.concat(chunks),
        headers: new Headers(convertNodeHeaders(response.headers)),
        statusCode: response.statusCode ?? 500,
        statusMessage: response.statusMessage ?? "",
        url: targetUrl.toString(),
      });
    });

    response.once("error", reject);
  });

  request.once("error", reject);

  if (body) {
    request.end(body);
    return;
  }

  request.end();
}

async function openSocksProxyConnection(proxy: URL, targetUrl: URL, signal: AbortSignal | undefined): Promise<net.Socket> {
  const proxyPort = Number(proxy.port || 1080);
  const socket = await connectSocket(proxy.hostname, proxyPort, signal);
  const reader = new SocketReader(socket);

  try {
    await negotiateSocksAuthentication(socket, reader, proxy, signal);
    await requestSocksConnection(socket, reader, targetUrl, signal);
    reader.detach();
    return socket;
  } catch (error) {
    reader.detach();
    socket.destroy();
    throw error;
  }
}

async function negotiateSocksAuthentication(
  socket: net.Socket,
  reader: SocketReader,
  proxy: URL,
  signal: AbortSignal | undefined,
): Promise<void> {
  const methods = proxy.username || proxy.password ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));

  const handshake = await reader.read(2, signal);

  if (handshake[0] !== 0x05) {
    throw new Error(`Unexpected SOCKS proxy version: ${handshake[0]}`);
  }

  if (handshake[1] === 0xff) {
    throw new Error("SOCKS proxy rejected all authentication methods.");
  }

  if (handshake[1] === 0x02) {
    const username = Buffer.from(decodeURIComponent(proxy.username));
    const password = Buffer.from(decodeURIComponent(proxy.password));

    if (username.length > 255 || password.length > 255) {
      throw new Error("SOCKS proxy username or password is too long.");
    }

    socket.write(Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]));

    const authResponse = await reader.read(2, signal);

    if (authResponse[1] !== 0x00) {
      throw new Error("SOCKS proxy authentication failed.");
    }

    return;
  }

  if (handshake[1] !== 0x00) {
    throw new Error(`Unsupported SOCKS proxy authentication method: ${handshake[1]}`);
  }
}

async function requestSocksConnection(
  socket: net.Socket,
  reader: SocketReader,
  targetUrl: URL,
  signal: AbortSignal | undefined,
): Promise<void> {
  const address = encodeSocksAddress(targetUrl.hostname);
  const port = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));

  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00]),
    address,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]));

  const head = await reader.read(4, signal);

  if (head[0] !== 0x05) {
    throw new Error(`Unexpected SOCKS proxy version: ${head[0]}`);
  }

  if (head[1] !== 0x00) {
    throw new Error(`SOCKS proxy connect failed with code ${head[1]}.`);
  }

  const replyAddressLength = await readSocksAddressLength(reader, head[3], signal);
  await reader.read(replyAddressLength + 2, signal);
}

function encodeSocksAddress(hostname: string): Buffer {
  const ipVersion = net.isIP(hostname);

  if (ipVersion === 4) {
    return Buffer.from([0x01, ...hostname.split(".").map((part) => Number(part))]);
  }

  if (ipVersion === 6) {
    const normalized = normalizeIpv6Segments(hostname);
    return Buffer.concat([Buffer.from([0x04]), Buffer.from(normalized)]);
  }

  const host = Buffer.from(hostname);

  if (host.length > 255) {
    throw new Error("SOCKS target hostname is too long.");
  }

  return Buffer.concat([Buffer.from([0x03, host.length]), host]);
}

async function readSocksAddressLength(
  reader: SocketReader,
  addressType: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (addressType === 0x01) {
    return 4;
  }

  if (addressType === 0x04) {
    return 16;
  }

  if (addressType === 0x03) {
    const [length] = await reader.read(1, signal);
    return length;
  }

  throw new Error(`Unsupported SOCKS address type: ${addressType}`);
}

function normalizeIpv6Segments(hostname: string): number[] {
  const expanded = expandIpv6Address(hostname);
  const bytes: number[] = [];

  for (const segment of expanded) {
    const value = Number.parseInt(segment, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  return bytes;
}

function expandIpv6Address(hostname: string): string[] {
  const [left, right] = hostname.split("::");
  const leftSegments = left ? left.split(":") : [];
  const rightSegments = right ? right.split(":") : [];

  if (hostname.includes("::")) {
    const missingSegments = 8 - (leftSegments.length + rightSegments.length);
    return [
      ...leftSegments,
      ...new Array(Math.max(missingSegments, 0)).fill("0"),
      ...rightSegments,
    ].map((segment) => segment || "0");
  }

  return hostname.split(":").map((segment) => segment || "0");
}

function connectSocket(hostname: string, port: number, signal: AbortSignal | undefined): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port });

    if (signal?.aborted) {
      socket.destroy(new Error("The operation was aborted."));
    }

    const onAbort = () => socket.destroy(new Error("The operation was aborted."));
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
      signal?.removeEventListener("abort", onAbort);
    };

    socket.once("error", onError);
    socket.once("connect", onConnect);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeRequestHeaders(headersInit: HeadersInit | undefined, body: Buffer | undefined, targetUrl: URL): Record<string, string> {
  const headers = new Headers(headersInit);

  if (!headers.has("host")) {
    headers.set("host", targetUrl.host);
  }

  if (body && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }

  return Object.fromEntries(headers.entries());
}

function convertNodeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  return result;
}

function buildProxyAuthorizationHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) {
    return undefined;
  }

  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
}

function shouldRedirect(statusCode: number, method: string): boolean {
  if (!redirectStatusCodes.has(statusCode)) {
    return false;
  }

  return method === "GET" || method === "HEAD" || statusCode === 303;
}

function assertSupportedTargetProtocol(targetUrl: URL): void {
  if (!supportedTargetProtocols.has(targetUrl.protocol)) {
    throw new Error(`Unsupported target protocol for proxy fetch: ${targetUrl.protocol}`);
  }
}

function parseProxyUrl(proxyUrl: string): URL {
  const parsed = new URL(proxyUrl);

  if (!supportedProxyProtocols.has(parsed.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }

  if (!parsed.hostname) {
    throw new Error("Proxy URL must include a hostname.");
  }

  return parsed;
}

async function readRequestBody(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString());
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }

  if (body instanceof ReadableStream) {
    throw new Error("ReadableStream request bodies are not supported with proxy fetch.");
  }

  return Buffer.from(String(body));
}

function toArrayBuffer(buffer: Buffer | undefined): ArrayBuffer | undefined {
  if (!buffer) {
    return undefined;
  }

  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

interface ProxyHttpResponse {
  body: Buffer;
  headers: Headers;
  statusCode: number;
  statusMessage: string;
  url: string;
}

class SocketReader {
  private buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private closedError: Error | undefined;
  private waiting:
    | {
        reject: (reason?: unknown) => void;
        resolve: () => void;
      }
    | undefined;

  constructor(private readonly socket: net.Socket) {
    this.socket.on("data", this.handleData);
    this.socket.on("close", this.handleClose);
    this.socket.on("end", this.handleClose);
    this.socket.on("error", this.handleError);
  }

  async read(size: number, signal: AbortSignal | undefined): Promise<Buffer> {
    while (this.bufferedBytes < size) {
      if (this.closedError) {
        throw this.closedError;
      }

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(new Error("The operation was aborted."));
        };
        const cleanup = () => {
          signal?.removeEventListener("abort", onAbort);

          if (this.waiting?.resolve === resolve) {
            this.waiting = undefined;
          }
        };

        this.waiting = {
          reject: (reason) => {
            cleanup();
            reject(reason);
          },
          resolve: () => {
            cleanup();
            resolve();
          },
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        if (this.closedError) {
          this.waiting.reject(this.closedError);
          return;
        }

        if (this.bufferedBytes >= size) {
          this.waiting.resolve();
        }
      });
    }

    return this.consume(size);
  }

  detach(): void {
    this.socket.off("data", this.handleData);
    this.socket.off("close", this.handleClose);
    this.socket.off("end", this.handleClose);
    this.socket.off("error", this.handleError);
    this.waiting = undefined;
  }

  private consume(size: number): Buffer {
    const result = Buffer.allocUnsafe(size);
    let offset = 0;

    while (offset < size) {
      const chunk = this.buffers[0];
      const remaining = size - offset;

      if (chunk.byteLength <= remaining) {
        chunk.copy(result, offset);
        this.buffers.shift();
        this.bufferedBytes -= chunk.byteLength;
        offset += chunk.byteLength;
        continue;
      }

      chunk.copy(result, offset, 0, remaining);
      this.buffers[0] = chunk.subarray(remaining);
      this.bufferedBytes -= remaining;
      offset += remaining;
    }

    return result;
  }

  private handleData = (chunk: Buffer): void => {
    this.buffers.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    this.waiting?.resolve();
  };

  private handleClose = (): void => {
    this.closedError = new Error("SOCKS proxy socket closed before the response was complete.");
    this.waiting?.reject(this.closedError);
  };

  private handleError = (error: Error): void => {
    this.closedError = error;
    this.waiting?.reject(error);
  };
}
