import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { access, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import type { BotSettings } from "./domain.js";

export const mangabuffTradesUrl = "https://mangabuff.ru/trades";
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

export async function startMangabuffManualAuth(
  storageStatePath = mangabuffStorageStatePath,
): Promise<ManualAuthSession> {
  const browserSession = await openMangabuffBrowser({
    headless: false,
    storageStatePath,
    useSavedSession: true,
  });

  await browserSession.page.goto(mangabuffTradesUrl, { waitUntil: "domcontentloaded" });

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
    await session.page.goto(mangabuffTradesUrl, { waitUntil: "domcontentloaded" });
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

async function openMangabuffBrowser(options: {
  headless: boolean;
  storageStatePath: string;
  useSavedSession: boolean;
}): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext({
    storageState:
      options.useSavedSession && (await fileExists(options.storageStatePath))
        ? options.storageStatePath
        : undefined,
  });
  const page = await context.newPage();

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
