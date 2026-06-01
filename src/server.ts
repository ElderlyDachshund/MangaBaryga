import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cancelMangabuffManualAuth,
  completeMangabuffManualAuth,
  mangabuffTradesUrl,
  startMangabuffManualAuth,
  type ManualAuthSession,
} from "./browser.js";
import { listTrades, loadSettings, openDatabase, saveSettingsPatch, type AppDatabase } from "./db.js";
import type { BotSettings } from "./domain.js";
import { autoLoginMangabuffHttpSession, checkSavedMangabuffHttpSession } from "./mangabuff-http.js";
import { runVisibleTradesLoop, type TradesPassResult } from "./trades.js";
import { assertTelegramConfigured } from "./telegram.js";

interface RuntimeState {
  running: boolean;
  stopping: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastPass?: TradesPassResult;
  lastError?: string;
}

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const webDistDir = join(process.cwd(), "dist", "web");
const db = openDatabase();
const runtime: RuntimeState = {
  running: false,
  stopping: false,
};
let botAbortController: AbortController | undefined;
let manualAuthSession: ManualAuthSession | undefined;
let autoLoginRefreshRunning = false;

export function startControlServer(port = readPort()): void {
  const hostname = readHostname();
  const app = createControlApp();

  serve(
    {
      fetch: app.fetch,
      hostname,
      port,
    },
    () => {
      const displayHostname = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
      console.log(`Панель управления: http://${displayHostname}:${port}`);
    },
  );

  if (process.env.AUTO_START_BOT === "true") {
    console.log("Автозапуск бота включён.");
    void startBot(db).catch((error) => {
      console.error(
        `Не удалось автоматически запустить бота: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else {
    console.log("Автозапуск бота выключен: AUTO_START_BOT не равно true.");
  }

  startAutoLoginRefreshLoop();
}

function createControlApp(): Hono {
  const app = new Hono();
  const webOrigins = readWebOrigins();

  app.onError((error) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;

    return jsonResponse(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      statusCode,
    );
  });

  if (webOrigins) {
    app.use(
      "/api/*",
      cors({
        allowHeaders: ["Content-Type"],
        allowMethods: ["GET", "PATCH", "POST", "OPTIONS"],
        origin: webOrigins,
      }),
    );
  }

  app.get("/api/state", (context) => context.json(buildState(db)));
  app.get("/health", (context) => context.json({ ok: true }));

  app.patch("/api/settings", async (context) => {
    const body = await readJsonBody(context.req.raw);
    const patch = parseSettingsPatch(body);
    const settings = saveSettingsPatch(db, patch);

    return context.json(sanitizeSettings(settings));
  });

  app.post("/api/bot/start", async (context) => {
    await startBot(db);

    return context.json(buildState(db));
  });

  app.post("/api/bot/stop", (context) => {
    stopBot();

    return context.json(buildState(db));
  });

  app.post("/api/auth/start", async (context) => {
    await startManualAuth();

    return context.json({ active: true });
  });

  app.post("/api/auth/complete", async (context) => {
    const saved = await completeManualAuth();

    return context.json({ saved }, saved ? 200 : 400);
  });

  app.post("/api/auth/cancel", async (context) => {
    await cancelManualAuth();

    return context.json({ active: false });
  });

  app.get("/api/auth/status", async (context) => {
    const authorized = await checkSavedMangabuffHttpSession();

    return context.json({ authorized });
  });

  app.all("/api/*", (context) => context.json({ error: "Not found" }, 404));
  app.use("/assets/*", serveStatic({ root: webDistDir }));
  app.get("*", async () => {
    const html = await readBuiltClientHtml();

    return new Response(html, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  });

  return app;
}

async function startBot(db: AppDatabase): Promise<void> {
  if (runtime.running) {
    return;
  }

  const settings = loadRuntimeSettings(db);
  assertTelegramConfigured(settings);

  const authorized = await checkSavedMangabuffHttpSession();

  if (!authorized) {
    throw new HttpError(400, "Нужна авторизация Mangabuff.");
  }

  botAbortController = new AbortController();
  runtime.running = true;
  runtime.stopping = false;
  runtime.startedAt = new Date().toISOString();
  runtime.stoppedAt = undefined;
  runtime.lastError = undefined;

  void runVisibleTradesLoop(db, settings, {
    getSettings: () => loadRuntimeSettings(db),
    signal: botAbortController.signal,
    onPass: (result) => {
      runtime.lastPass = result;
    },
  })
    .catch((error) => {
      runtime.lastError = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      runtime.running = false;
      runtime.stopping = false;
      runtime.stoppedAt = new Date().toISOString();
      botAbortController = undefined;
    });
}

function stopBot(): void {
  if (!botAbortController) {
    runtime.running = false;
    runtime.stopping = false;
    return;
  }

  runtime.stopping = true;
  botAbortController.abort();
}

async function startManualAuth(): Promise<void> {
  if (manualAuthSession) {
    if (await focusManualAuth(manualAuthSession)) {
      return;
    }

    await cancelMangabuffManualAuth(manualAuthSession).catch(() => {});
    manualAuthSession = undefined;
  }

  manualAuthSession = await startMangabuffManualAuth();
}

async function completeManualAuth(): Promise<boolean> {
  if (!manualAuthSession) {
    throw new HttpError(400, "Окно авторизации не запущено.");
  }

  let saved: boolean;

  try {
    saved = await completeMangabuffManualAuth(manualAuthSession);
  } catch (error) {
    if (!isManualAuthConnected(manualAuthSession)) {
      manualAuthSession = undefined;
    }

    throw error;
  }

  if (saved) {
    manualAuthSession = undefined;
  }

  return saved;
}

async function cancelManualAuth(): Promise<void> {
  if (!manualAuthSession) {
    return;
  }

  await cancelMangabuffManualAuth(manualAuthSession);
  manualAuthSession = undefined;
}

async function focusManualAuth(authSession: ManualAuthSession): Promise<boolean> {
  if (!isManualAuthConnected(authSession)) {
    return false;
  }

  const { page } = authSession.browserSession;

  await page.bringToFront().catch(() => {});

  if (page.url() === "about:blank") {
    await page.goto(mangabuffTradesUrl, { waitUntil: "commit", timeout: 10_000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
  }

  return isManualAuthConnected(authSession);
}

function isManualAuthConnected(authSession: ManualAuthSession): boolean {
  return authSession.browserSession.browser.isConnected() && !authSession.browserSession.page.isClosed();
}

function buildState(db: AppDatabase): object {
  return {
    settings: sanitizeSettings(loadRuntimeSettings(db)),
    runtime,
    auth: {
      manualAuthActive: Boolean(manualAuthSession),
    },
    trades: listTrades(db, 50),
  };
}

function loadRuntimeSettings(db: AppDatabase): BotSettings {
  const settings = loadSettings(db);
  const telegramBotToken = readFirstOptionalEnv([
    "MANGA_TELEGRAM_BOT_TOKEN",
    "APP_TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
  ]);
  const telegramChatId = readFirstOptionalEnv(["MANGA_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"]);

  if (telegramBotToken) {
    settings.telegramBotToken = telegramBotToken;
  }

  if (telegramChatId) {
    settings.telegramChatId = telegramChatId;
  }

  return settings;
}

function sanitizeSettings(settings: BotSettings): object {
  return {
    telegramConfigured: Boolean(settings.telegramBotToken && settings.telegramChatId),
    telegramChatId: maskSecret(settings.telegramChatId),
    safeMode: settings.safeMode,
    autoAcceptEnabled: settings.autoAcceptEnabled,
    autoAcceptLocked: false,
    maxWantedPagesExclusive: settings.maxWantedPagesExclusive,
    loopPauseMs: settings.loopPauseMs,
    browserMode: settings.browserMode,
    rankRecognitionVerified: settings.rankRecognitionVerified,
  };
}

function parseSettingsPatch(body: unknown): Partial<BotSettings> {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Некорректные настройки.");
  }

  const source = body as Record<string, unknown>;
  const patch: Partial<BotSettings> = {};

  if (typeof source.telegramBotToken === "string" && source.telegramBotToken.trim()) {
    patch.telegramBotToken = source.telegramBotToken.trim();
  }

  if (typeof source.telegramChatId === "string" && source.telegramChatId.trim()) {
    patch.telegramChatId = source.telegramChatId.trim();
  }

  if (source.maxWantedPagesExclusive !== undefined) {
    const value = Number(source.maxWantedPagesExclusive);

    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new HttpError(400, "Максимум страниц желающих должен быть целым числом от 1 до 100.");
    }

    patch.maxWantedPagesExclusive = value;
  }

  if (source.loopPauseMs !== undefined) {
    const value = Number(source.loopPauseMs);

    if (!Number.isInteger(value) || value < 1_000 || value > 10_000) {
      throw new HttpError(400, "Пауза между проходами должна быть от 1000 до 10000 мс.");
    }

    patch.loopPauseMs = value;
  }

  if (source.browserMode !== undefined) {
    if (source.browserMode !== "headless" && source.browserMode !== "headful") {
      throw new HttpError(400, "Режим браузера должен быть headless или headful.");
    }

    patch.browserMode = source.browserMode;
  }

  if (source.safeMode !== undefined) {
    if (typeof source.safeMode !== "boolean") {
      throw new HttpError(400, "Безопасный режим должен быть true или false.");
    }

    patch.safeMode = source.safeMode;
  }

  if (source.autoAcceptEnabled !== undefined) {
    if (typeof source.autoAcceptEnabled !== "boolean") {
      throw new HttpError(400, "Автопринятие должно быть true или false.");
    }

    patch.autoAcceptEnabled = source.autoAcceptEnabled;
  }

  return patch;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const body = await request.text();

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "Некорректный JSON.");
  }
}

function jsonResponse(payload: unknown, statusCode: number): Response {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function readBuiltClientHtml(): Promise<string> {
  try {
    return await readFile(join(webDistDir, "index.html"), "utf8");
  } catch {
    return renderMissingClientHtml();
  }
}

function renderMissingClientHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Обмены Mangabuff</title>
</head>
<body style="font-family: system-ui, sans-serif; margin: 40px; line-height: 1.5">
  <h1>Панель ещё не собрана</h1>
  <p>Запусти <code>npm run build:web</code>, затем снова открой эту страницу.</p>
</body>
</html>`;
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.length <= 6) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function readPort(): number {
  const defaultPort = process.env.NODE_ENV === "production" ? 3000 : 3017;
  const port = Number(process.env.PORT ?? defaultPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PORT должен быть целым числом от 1 до 65535.");
  }

  return port;
}

function readFirstOptionalEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function startAutoLoginRefreshLoop(): void {
  const intervalHours = readAutoLoginIntervalHours();

  if (!intervalHours) {
    return;
  }

  const login = process.env.MANGABUFF_LOGIN?.trim();
  const password = process.env.MANGABUFF_PASSWORD?.trim();

  if (!login || !password) {
    console.warn(
      "Автообновление авторизации Mangabuff выключено: нужны MANGABUFF_LOGIN и MANGABUFF_PASSWORD.",
    );
    return;
  }

  const intervalMs = intervalHours * 60 * 60 * 1_000;
  const scheduleNext = () => {
    setTimeout(() => {
      void runAutoLoginRefresh(login, password).finally(scheduleNext);
    }, intervalMs);
  };

  console.log(`Автологин Mangabuff будет запускаться каждые ${intervalHours} ч.`);
  scheduleNext();
}

async function runAutoLoginRefresh(login: string, password: string): Promise<void> {
  if (autoLoginRefreshRunning) {
    return;
  }

  autoLoginRefreshRunning = true;
  const shouldRestartBot = runtime.running;

  try {
    if (shouldRestartBot) {
      stopBot();
      await waitForBotStopped();
    }

    const saved = await autoLoginMangabuffHttpSession({ login, password });

    const time = new Date().toLocaleString("ru-RU");
    console.log(
      saved
        ? `[${time}] Автологин Mangabuff выполнен, сессия сохранена.`
        : `[${time}] Автологин Mangabuff не подтвердил авторизацию.`,
    );

    if (saved && shouldRestartBot) {
      await startBot(db);
    }
  } catch (error) {
    console.error(`Ошибка автологина Mangabuff: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    autoLoginRefreshRunning = false;
  }
}

function readAutoLoginIntervalHours(): number | undefined {
  const value = process.env.MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS?.trim();

  if (!value) {
    return undefined;
  }

  const hours = Number(value);

  if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
    throw new Error("MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS должен быть числом от 1 до 168.");
  }

  return hours;
}

async function waitForBotStopped(timeoutMs = 660_000): Promise<void> {
  const startedAt = Date.now();

  while (runtime.running && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (runtime.running) {
    throw new Error("Не удалось дождаться остановки бота перед автологином Mangabuff.");
  }
}

function readHostname(): string {
  return process.env.HOST?.trim() || "127.0.0.1";
}

function readWebOrigins(): string | string[] | undefined {
  const origins = process.env.WEB_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!origins?.length) {
    return undefined;
  }

  return origins.length === 1 ? origins[0] : origins;
}
