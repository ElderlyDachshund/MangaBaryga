import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { mangabuffStorageStatePath } from "./browser.js";

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
}

interface StorageState {
  cookies: StorageStateCookie[];
}

export interface MangabuffTextResponse {
  url: string;
  status: number;
  ok: boolean;
  text: string;
}

export interface MangabuffBytesResponse {
  url: string;
  status: number;
  ok: boolean;
  bytes: Uint8Array;
}

export interface MangabuffJsonResponse {
  url: string;
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
}

export interface MangabuffSessionClient {
  getText(url: string, timeoutMs?: number): Promise<MangabuffTextResponse>;
  getBytes(url: string, timeoutMs?: number): Promise<MangabuffBytesResponse>;
  postJson(
    url: string,
    data: unknown,
    options?: {
      csrfToken?: string;
      referer?: string;
      timeoutMs?: number;
    },
  ): Promise<MangabuffJsonResponse>;
}

export class MangabuffHttpSession implements MangabuffSessionClient {
  private nextRequestAt = 0;

  constructor(private readonly cookies: StorageStateCookie[]) {}

  async getText(url: string, timeoutMs = 20_000): Promise<MangabuffTextResponse> {
    const response = await this.fetch(url, timeoutMs, "text/html,application/xhtml+xml");

    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      text: await response.text(),
    };
  }

  async getBytes(url: string, timeoutMs = 20_000): Promise<MangabuffBytesResponse> {
    const response = await this.fetch(url, timeoutMs, "image/avif,image/webp,image/png,image/*,*/*;q=0.8");

    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  async postJson(
    url: string,
    data: unknown,
    options: {
      csrfToken?: string;
      referer?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<MangabuffJsonResponse> {
    const response = await this.fetch(url, options.timeoutMs ?? 20_000, "application/json, text/plain, */*", {
      body: JSON.stringify(data),
      contentType: "application/json",
      csrfToken: options.csrfToken,
      method: "POST",
      referer: options.referer,
      requestedWith: true,
    });
    const text = await response.text();

    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      json: parseJsonSafely(text),
      text,
    };
  }

  private async fetch(
    url: string,
    timeoutMs: number,
    accept: string,
    options: {
      body?: BodyInit;
      contentType?: string;
      csrfToken?: string;
      method?: string;
      referer?: string;
      requestedWith?: boolean;
    } = {},
  ): Promise<Response> {
    await this.waitForRateLimit();

    const headers: Record<string, string> = {
      accept,
      cookie: this.buildCookieHeader(url),
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    };

    if (options.contentType) {
      headers["content-type"] = options.contentType;
    }

    if (options.csrfToken) {
      headers["x-csrf-token"] = options.csrfToken;
    }

    if (options.referer) {
      headers.referer = options.referer;
    }

    if (options.method && options.method !== "GET") {
      headers.origin = "https://mangabuff.ru";
    }

    if (options.requestedWith) {
      headers["x-requested-with"] = "XMLHttpRequest";
    }

    const response = await fetch(url, {
      body: options.body,
      headers,
      method: options.method ?? "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 429) {
      await sleep(readRetryAfterMs(response) ?? defaultRateLimitRetryMs);
    }

    return response;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    this.nextRequestAt = Date.now() + defaultRequestDelayMs + Math.floor(Math.random() * defaultRequestJitterMs);
  }

  private buildCookieHeader(url: string): string {
    const target = new URL(url);
    const now = Date.now() / 1_000;

    return this.cookies
      .filter((cookie) => cookie.expires < 0 || cookie.expires > now)
      .filter((cookie) => cookieMatchesUrl(cookie, target))
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }
}

export async function openSavedMangabuffHttpSession(
  storageStatePath = mangabuffStorageStatePath,
): Promise<MangabuffHttpSession> {
  const state = JSON.parse(await readFile(storageStatePath, "utf8")) as StorageState;
  return new MangabuffHttpSession(state.cookies);
}

function cookieMatchesUrl(cookie: StorageStateCookie, url: URL): boolean {
  const cookieDomain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  const domainMatches = url.hostname === cookieDomain || url.hostname.endsWith(`.${cookieDomain}`);

  if (!domainMatches) {
    return false;
  }

  return url.pathname.startsWith(cookie.path);
}

const defaultRequestDelayMs = readIntegerEnv("MANGABUFF_HTTP_REQUEST_DELAY_MS", 1_500, 250, 30_000);
const defaultRequestJitterMs = readIntegerEnv("MANGABUFF_HTTP_REQUEST_JITTER_MS", 750, 0, 30_000);
const defaultRateLimitRetryMs = readIntegerEnv("MANGABUFF_HTTP_RATE_LIMIT_RETRY_MS", 30_000, 1_000, 120_000);

function readRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, 120_000);
  }

  const date = Date.parse(retryAfter);

  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - Date.now()), 120_000);
  }

  return undefined;
}

function readIntegerEnv(name: string, defaultValue: number, min: number, max: number): number {
  const value = process.env[name];

  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return defaultValue;
  }

  return Math.max(min, Math.min(max, parsed));
}

function parseJsonSafely(text: string): unknown {
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}
