import type { Browser, BrowserContext, Page } from "playwright";
import { access, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import type { BotSettings } from "./domain.js";
import { assertMangabuffPageReady, clickVerified } from "./browser-safety.js";
import { installMangabuffNavigationPolicy } from "./navigation-policy.js";
import { readBrowserProxySettings } from "./proxy.js";

export const mangabuffTradesUrl = "https://mangabuff.ru/trades";
export const mangabuffLoginUrl = "https://mangabuff.ru/login";
export const mangabuffLogoutUrl = "https://mangabuff.ru/logout";
export const mangabuffStorageStatePath =
  process.env.MANGABUFF_STORAGE_STATE_PATH ?? "playwright/.auth/mangabuff.json";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export interface ManualAuthSession {
  browserSession: BrowserSession;
  storageStatePath: string;
}

export interface MangabuffAutoLoginOptions {
  headless?: boolean;
  login: string;
  password: string;
  storageStatePath?: string;
}

export async function saveMangabuffSession(
  storageStatePath = mangabuffStorageStatePath,
): Promise<void> {
  const session = await openMangabuffBrowser({
    headless: false,
    storageStatePath,
    useSavedSession: false,
  });

  try {
    await session.page.goto(mangabuffTradesUrl, { waitUntil: "domcontentloaded" });
    console.log("Открыл Mangabuff в видимом браузере.");
    console.log("Войди в аккаунт вручную, затем вернись в терминал и нажми Enter.");

    const rl = createInterface({ input, output });
    await rl.question("");
    rl.close();

    await mkdir(dirname(storageStatePath), { recursive: true });
    await session.context.storageState({ path: storageStatePath });
    console.log(`Сессия сохранена: ${storageStatePath}`);
  } finally {
    await session.browser.close();
  }
}

export async function autoLoginMangabuffSession(options: MangabuffAutoLoginOptions): Promise<boolean> {
  const storageStatePath = options.storageStatePath ?? mangabuffStorageStatePath;
  const session = await openMangabuffBrowser({
    headless: options.headless ?? true,
    storageStatePath,
    useSavedSession: true,
  });

  try {
    await session.page.goto(mangabuffLogoutUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    const loginResponse = await session.page.goto(mangabuffLoginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await assertMangabuffPageReady(session.page, loginResponse?.status());
    await session.page.locator('input[name="email"]').first().fill(options.login);
    await session.page.locator('input[name="password"]').first().fill(options.password);

    await Promise.all([
      session.page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20_000 }).catch(() => undefined),
      clickVerified(session.page.locator(".login-button").first(), "кнопка входа"),
    ]);

    await session.page.waitForLoadState("domcontentloaded").catch(() => {});
    await assertMangabuffPageReady(session.page);
    await session.page.goto(mangabuffTradesUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});

    const isAuthorized = await isMangabuffAuthorized(session.page);

    if (!isAuthorized) {
      return false;
    }

    await mkdir(dirname(storageStatePath), { recursive: true });
    await session.context.storageState({ path: storageStatePath });

    return true;
  } finally {
    await session.browser.close();
  }
}

export async function startMangabuffManualAuth(
  storageStatePath = mangabuffStorageStatePath,
): Promise<ManualAuthSession> {
  const browserSession = await openMangabuffBrowser({
    headless: false,
    storageStatePath,
    useSavedSession: true,
  });

  await browserSession.page.bringToFront().catch(() => {});
  await browserSession.page.goto(mangabuffTradesUrl, { waitUntil: "commit", timeout: 10_000 }).catch(() => {});
  await browserSession.page.bringToFront().catch(() => {});

  return { browserSession, storageStatePath };
}

export async function completeMangabuffManualAuth(authSession: ManualAuthSession): Promise<boolean> {
  const isAuthorized = await isMangabuffAuthorized(authSession.browserSession.page);

  if (!isAuthorized) {
    return false;
  }

  await mkdir(dirname(authSession.storageStatePath), { recursive: true });
  await authSession.browserSession.context.storageState({ path: authSession.storageStatePath });
  await authSession.browserSession.browser.close();

  return true;
}

export async function cancelMangabuffManualAuth(authSession: ManualAuthSession): Promise<void> {
  await authSession.browserSession.browser.close();
}

export async function checkMangabuffSession(
  settings: BotSettings,
  storageStatePath = mangabuffStorageStatePath,
): Promise<boolean> {
  if (!(await fileExists(storageStatePath))) {
    return false;
  }

  const session = await openMangabuffBrowser({
    headless: settings.browserMode === "headless",
    storageStatePath,
    useSavedSession: true,
  });

  try {
    const response = await session.page.goto(mangabuffTradesUrl, {
      waitUntil: "domcontentloaded",
    });
    await assertMangabuffPageReady(session.page, response?.status());
    return await isMangabuffAuthorized(session.page);
  } finally {
    await session.browser.close();
  }
}

export async function openSavedMangabuffSession(
  settings: BotSettings,
  storageStatePath = mangabuffStorageStatePath,
): Promise<BrowserSession> {
  if (!(await fileExists(storageStatePath))) {
    throw new Error(`Сессия Mangabuff не найдена: ${storageStatePath}`);
  }

  return openMangabuffBrowser({
    headless: settings.browserMode === "headless",
    storageStatePath,
    useSavedSession: true,
  });
}

export async function saveBrowserSessionState(
  session: BrowserSession,
  storageStatePath = mangabuffStorageStatePath,
): Promise<void> {
  await mkdir(dirname(storageStatePath), { recursive: true });
  await session.context.storageState({ path: storageStatePath });
}

async function openMangabuffBrowser(options: {
  headless: boolean;
  storageStatePath: string;
  useSavedSession: boolean;
}): Promise<BrowserSession> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
    // The full Chromium build is more reliable than chrome-headless-shell on macOS
    // and also supports the optional headful diagnostics mode.
    executablePath: chromium.executablePath(),
    headless: options.headless,
    proxy: readBrowserProxySettings(),
  });
  const context = await browser.newContext({
    storageState:
      options.useSavedSession && (await fileExists(options.storageStatePath))
        ? options.storageStatePath
        : undefined,
  });
  await installMangabuffNavigationPolicy(context);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(3_660_000);

  context.on("page", (openedPage) => {
    if (openedPage !== page) {
      void openedPage.close();
    }
  });

  return { browser, context, page };
}

export async function isMangabuffAuthorized(page: Page): Promise<boolean> {
  const url = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");

  if (url.includes("login") || url.includes("auth")) {
    return false;
  }

  if (bodyText.includes("Предложения") || bodyText.includes("Отправленные")) {
    return true;
  }

  return !bodyText.includes("Войти") && !bodyText.includes("Авторизация");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
