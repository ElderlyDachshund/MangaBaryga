import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mangabuffLoginUrl, mangabuffStorageStatePath, mangabuffTradesUrl } from "./browser.js";
import { logInfo, logWarn } from "./logger.js";

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

interface StorageState {
  cookies: StorageStateCookie[];
  origins?: unknown[];
  [key: string]: unknown;
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
  postForm(
    url: string,
    data: unknown,
    options?: {
      csrfToken?: string;
      referer?: string;
      timeoutMs?: number;
    },
  ): Promise<MangabuffJsonResponse>;
}

export interface MangabuffHttpAutoLoginOptions {
  login: string;
  password: string;
  storageStatePath?: string;
}

export class MangabuffHttpSession implements MangabuffSessionClient {
  private nextRequestAt = 0;
  private cookiesDirty = false;

  constructor(
    private readonly cookies: StorageStateCookie[],
    private readonly storageState?: StorageState,
    private readonly storageStatePath?: string,
  ) {}

  async getText(url: string, timeoutMs = 20_000): Promise<MangabuffTextResponse> {
    const response = await this.fetch(url, timeoutMs, "text/html,application/xhtml+xml");

    return {
      url: response.url || url,
      status: response.status,
      ok: response.ok,
      text: await response.text(),
    };
  }

  async getBytes(url: string, timeoutMs = 20_000): Promise<MangabuffBytesResponse> {
    const response = await this.fetch(url, timeoutMs, "image/avif,image/webp,image/png,image/*,*/*;q=0.8");

    return {
      url: response.url || url,
      status: response.status,
      ok: response.ok,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  async postForm(
    url: string,
    data: unknown,
    options: {
      csrfToken?: string;
      referer?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<MangabuffJsonResponse> {
    const body = buildFormUrlEncodedBody(data);
    const response = await this.fetch(url, options.timeoutMs ?? 20_000, body ? "application/json, text/plain, */*" : "*/*", {
      body: body || undefined,
      contentType: body ? "application/x-www-form-urlencoded; charset=UTF-8" : undefined,
      csrfToken: options.csrfToken,
      method: "POST",
      referer: options.referer,
      requestedWith: true,
    });
    const text = await response.text();

    return {
      url: response.url || url,
      status: response.status,
      ok: response.ok,
      json: parseJsonSafely(text),
      text,
    };
  }

  async saveStorageState(): Promise<boolean> {
    if (!this.cookiesDirty || !this.storageState || !this.storageStatePath) {
      return false;
    }

    this.storageState.cookies = this.cookies;
    await mkdir(dirname(this.storageStatePath), { recursive: true });
    await writeFile(this.storageStatePath, `${JSON.stringify(this.storageState, null, 2)}\n`, "utf8");
    this.cookiesDirty = false;

    return true;
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

    this.storeResponseCookies(response, url);

    if (response.status === 429) {
      const retryAfterMs = readRetryAfterMs(response) ?? defaultRateLimitRetryMs;
      logWarn("Mangabuff rate limit response received", {
        retryAfterMs,
        status: response.status,
        url,
      });
      await sleep(retryAfterMs);
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

  private storeResponseCookies(response: Response, requestUrl: string): void {
    const setCookieHeaders = readSetCookieHeaders(response.headers);

    if (setCookieHeaders.length === 0) {
      return;
    }

    const responseUrl = new URL(response.url || requestUrl);

    for (const header of setCookieHeaders) {
      const cookie = parseSetCookieHeader(header, responseUrl);

      if (!cookie) {
        continue;
      }

      const existingIndex = this.cookies.findIndex(
        (existing) =>
          existing.name === cookie.name &&
          normalizeCookieDomain(existing.domain) === normalizeCookieDomain(cookie.domain) &&
          existing.path === cookie.path,
      );

      if (cookie.expires >= 0 && cookie.expires <= Date.now() / 1_000) {
        if (existingIndex >= 0) {
          this.cookies.splice(existingIndex, 1);
          this.cookiesDirty = true;
        }

        continue;
      }

      if (existingIndex >= 0) {
        this.cookies[existingIndex] = cookie;
      } else {
        this.cookies.push(cookie);
      }

      this.cookiesDirty = true;
    }
  }
}

export async function openSavedMangabuffHttpSession(
  storageStatePath = mangabuffStorageStatePath,
): Promise<MangabuffHttpSession> {
  const state = JSON.parse(await readFile(storageStatePath, "utf8")) as StorageState;
  return new MangabuffHttpSession(state.cookies, state, storageStatePath);
}

export async function autoLoginMangabuffHttpSession(options: MangabuffHttpAutoLoginOptions): Promise<boolean> {
  const storageStatePath = options.storageStatePath ?? mangabuffStorageStatePath;
  const storageState: StorageState = {
    cookies: [],
    origins: [{ localStorage: [], origin: "https://mangabuff.ru" }],
  };
  const session = new MangabuffHttpSession(storageState.cookies, storageState, storageStatePath);

  logInfo("Mangabuff HTTP auto-login started", { storageStatePath });

  const loginPage = await session.getText(mangabuffLoginUrl);
  const csrfToken = extractCsrfToken(loginPage.text);

  if (!loginPage.ok || !csrfToken) {
    logWarn("Mangabuff HTTP auto-login could not read login page", {
      hasCsrfToken: Boolean(csrfToken),
      status: loginPage.status,
      url: loginPage.url,
    });
    return false;
  }

  const loginResponse = await session.postForm(
    mangabuffLoginUrl,
    {
      email: options.login,
      password: options.password,
    },
    {
      csrfToken,
      referer: mangabuffLoginUrl,
    },
  );

  if (!loginResponse.ok) {
    logWarn("Mangabuff HTTP auto-login POST failed", {
      status: loginResponse.status,
      url: loginResponse.url,
    });
    return false;
  }

  const tradesPage = await session.getText(mangabuffTradesUrl);

  if (!isMangabuffAuthorizedHttpResponse(tradesPage)) {
    logWarn("Mangabuff HTTP auto-login did not produce authorized session", {
      status: tradesPage.status,
      url: tradesPage.url,
    });
    return false;
  }

  await session.saveStorageState();
  logInfo("Mangabuff HTTP auto-login saved authorized session", { storageStatePath });

  return true;
}

export async function checkSavedMangabuffHttpSession(
  storageStatePath = mangabuffStorageStatePath,
): Promise<boolean> {
  let session: MangabuffHttpSession;

  try {
    session = await openSavedMangabuffHttpSession(storageStatePath);
  } catch (error) {
    if (isFileMissingError(error)) {
      logWarn("Saved Mangabuff HTTP session file is missing", { storageStatePath });
      return false;
    }

    throw error;
  }

  const response = await session.getText(mangabuffTradesUrl);
  await session.saveStorageState();

  const authorized = isMangabuffAuthorizedHttpResponse(response);
  logInfo("Saved Mangabuff HTTP session checked", {
    authorized,
    status: response.status,
    url: response.url,
  });

  return authorized;
}

export function isMangabuffAuthorizedHttpResponse(response: MangabuffTextResponse): boolean {
  const url = new URL(response.url);
  const text = htmlToText(response.text);

  if (url.pathname.includes("login") || url.pathname.includes("auth")) {
    return false;
  }

  if (text.includes("предложения") || text.includes("отправленные")) {
    return true;
  }

  return !text.includes("войти") && !text.includes("авторизация");
}

function cookieMatchesUrl(cookie: StorageStateCookie, url: URL): boolean {
  const cookieDomain = normalizeCookieDomain(cookie.domain);
  const domainMatches = url.hostname === cookieDomain || url.hostname.endsWith(`.${cookieDomain}`);

  if (!domainMatches) {
    return false;
  }

  return url.pathname.startsWith(cookie.path);
}

function normalizeCookieDomain(domain: string): string {
  return domain.startsWith(".") ? domain.slice(1) : domain;
}

function readSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;

  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }

  const setCookie = headers.get("set-cookie");

  if (!setCookie) {
    return [];
  }

  return splitCombinedSetCookieHeader(setCookie);
}

function splitCombinedSetCookieHeader(header: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];

    if (char === ",") {
      if (!inExpires) {
        cookies.push(header.slice(start, index).trim());
        start = index + 1;
      }

      continue;
    }

    if (char === ";") {
      inExpires = false;
      continue;
    }

    if (header.slice(index, index + 8).toLowerCase() === "expires=") {
      inExpires = true;
      index += 7;
    }
  }

  cookies.push(header.slice(start).trim());
  return cookies.filter(Boolean);
}

function parseSetCookieHeader(header: string, responseUrl: URL): StorageStateCookie | undefined {
  const [nameValue, ...attributes] = header.split(";");
  const equalsIndex = nameValue.indexOf("=");

  if (equalsIndex <= 0) {
    return undefined;
  }

  const name = nameValue.slice(0, equalsIndex).trim();

  if (!name) {
    return undefined;
  }

  const cookie: StorageStateCookie = {
    domain: responseUrl.hostname,
    expires: -1,
    name,
    path: defaultCookiePath(responseUrl.pathname),
    value: nameValue.slice(equalsIndex + 1).trim(),
  };

  for (const attribute of attributes) {
    const [rawName, ...rawValueParts] = attribute.trim().split("=");
    const attributeName = rawName.toLowerCase();
    const attributeValue = rawValueParts.join("=");

    if (attributeName === "domain" && attributeValue) {
      cookie.domain = attributeValue.trim().replace(/^\./, "");
    } else if (attributeName === "path" && attributeValue) {
      cookie.path = attributeValue.trim();
    } else if (attributeName === "httponly") {
      cookie.httpOnly = true;
    } else if (attributeName === "secure") {
      cookie.secure = true;
    } else if (attributeName === "samesite" && attributeValue) {
      cookie.sameSite = normalizeSameSite(attributeValue);
    } else if (attributeName === "expires" && attributeValue) {
      const expires = Date.parse(attributeValue);

      if (Number.isFinite(expires)) {
        cookie.expires = Math.floor(expires / 1_000);
      }
    } else if (attributeName === "max-age" && attributeValue) {
      const maxAgeSeconds = Number(attributeValue);

      if (Number.isFinite(maxAgeSeconds)) {
        cookie.expires = Math.floor(Date.now() / 1_000 + maxAgeSeconds);
      }
    }
  }

  return cookie;
}

function normalizeSameSite(value: string): "Strict" | "Lax" | "None" | undefined {
  const normalized = value.trim().toLowerCase();

  if (normalized === "strict") {
    return "Strict";
  }

  if (normalized === "none") {
    return "None";
  }

  if (normalized === "lax") {
    return "Lax";
  }

  return undefined;
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/")) {
    return "/";
  }

  const lastSlashIndex = pathname.lastIndexOf("/");

  if (lastSlashIndex <= 0) {
    return "/";
  }

  return pathname.slice(0, lastSlashIndex);
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
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

function buildFormUrlEncodedBody(data: unknown): string {
  if (data instanceof URLSearchParams) {
    return data.toString();
  }

  if (!data || typeof data !== "object") {
    return "";
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    appendFormValue(params, key, value);
  }

  return params.toString();
}

function appendFormValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendFormValue(params, key, item);
    }

    return;
  }

  params.append(key, String(value));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractCsrfToken(html: string): string | undefined {
  return (
    html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i)?.[1]
  );
}
