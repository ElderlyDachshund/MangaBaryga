import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cancelMangabuffManualAuth,
  completeMangabuffManualAuth,
  mangabuffTradesUrl,
  mangabuffStorageStatePath,
  startMangabuffManualAuth,
  type ManualAuthSession,
} from "./browser.js";
import {
  listTrades,
  loadSettings,
  openDatabase,
  runDatabaseMaintenance,
  saveSettingsPatch,
  type AppDatabase,
} from "./db.js";
import type { BotSettings } from "./domain.js";
import { formatError, logError, logInfo, logWarn } from "./logger.js";
import { autoLoginMangabuffHttpSession, checkSavedMangabuffHttpSession } from "./mangabuff-http.js";
import { readMangabuffProxyUrl } from "./proxy.js";
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

interface AuthRuntimeState {
  authorized?: boolean;
  lastAttemptAt?: string;
  lastFailureReason?: string;
  lastSuccessAt?: string;
  recoveryScheduledAt?: string;
}

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface MangabuffCredentials {
  login: string;
  password: string;
}

const webDistDir = join(process.cwd(), "dist", "web");
const db = openDatabase();
const runtime: RuntimeState = {
  running: false,
  stopping: false,
};
const authRuntime: AuthRuntimeState = {};
let botAbortController: AbortController | undefined;
let manualAuthSession: ManualAuthSession | undefined;
let autoLoginRefreshRunning = false;
let authRecoveryTimer: ReturnType<typeof setTimeout> | undefined;

export function startControlServer(port = readPort()): void {
  const hostname = readHostname();
  const app = createControlApp();

  void logStartupDiagnostics(hostname, port);
  performDatabaseMaintenance("startup");

  serve(
    {
      fetch: app.fetch,
      hostname,
      port,
    },
    () => {
      const displayHostname = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
      logInfo("Control server listening", {
        hostname,
        port,
        url: `http://${displayHostname}:${port}`,
      });
    },
  );

  if (process.env.AUTO_START_BOT === "true") {
    logInfo("Bot autostart enabled");
    void startBot(db).catch((error) => {
      logError("Bot autostart failed", { error: formatError(error) });
    });
  } else {
    logInfo("Bot autostart disabled", { AUTO_START_BOT: process.env.AUTO_START_BOT });
  }

  startAutoLoginRefreshLoop();
}

function createControlApp(): Hono {
  const app = new Hono();
  const webOrigins = readWebOrigins();

  app.onError((error, context) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;

    logError("HTTP request failed", {
      error: error instanceof Error ? error.message : String(error),
      method: context.req.method,
      path: new URL(context.req.url).pathname,
      statusCode,
    });

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
  app.get("/api/diagnostics", async (context) => context.json(await buildDiagnostics()));
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

    if (authorized) {
      markAuthAuthorized("status_endpoint");
    } else {
      markAuthUnauthorized("status_endpoint_failed");
    }

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
    logInfo("Bot start skipped because loop is already running");
    return;
  }

  const settings = loadRuntimeSettings(db);
  logInfo("Bot start requested", {
    autoAcceptEnabled: settings.autoAcceptEnabled,
    browserMode: settings.browserMode,
    loopPauseMs: settings.loopPauseMs,
    maxWantedPagesExclusive: settings.maxWantedPagesExclusive,
    safeMode: settings.safeMode,
    telegramConfigured: Boolean(settings.telegramBotToken && settings.telegramChatId),
  });

  assertTelegramConfigured(settings);

  const authorized = await ensureSavedMangabuffSessionAuthorized();

  if (!authorized) {
    logWarn("Saved Mangabuff HTTP session is not authorized");
    throw new HttpError(400, "Нужна авторизация Mangabuff.");
  }

  botAbortController = new AbortController();
  runtime.running = true;
  runtime.stopping = false;
  runtime.startedAt = new Date().toISOString();
  runtime.stoppedAt = undefined;
  runtime.lastError = undefined;
  runtime.lastPass = undefined;

  logInfo("Bot loop started", { startedAt: runtime.startedAt });
  const loopController = botAbortController;

  void runVisibleTradesLoop(db, settings, {
    getSettings: () => loadRuntimeSettings(db),
    signal: loopController.signal,
    onPass: (result) => {
      runtime.lastPass = result;
      logTradesPass(result);

      if (result.passNumber % 25 === 0) {
        performDatabaseMaintenance(`pass_${result.passNumber}`);
      }
    },
  })
    .catch((error) => {
      runtime.lastError = formatError(error);
      logError("Bot loop failed", { error: runtime.lastError });
    })
    .finally(async () => {
      const shouldAutoRestart =
        runtime.lastPass?.status === "auth_required" && !runtime.stopping && !loopController.signal.aborted;

      runtime.running = false;
      runtime.stopping = false;
      runtime.stoppedAt = new Date().toISOString();
      botAbortController = undefined;
      logInfo("Bot loop stopped", {
        lastError: runtime.lastError,
        stoppedAt: runtime.stoppedAt,
      });

      if (shouldAutoRestart) {
        await restartBotAfterAuthRequired(db);
      }
    });
}

function stopBot(): void {
  if (!botAbortController) {
    runtime.running = false;
    runtime.stopping = false;
    logInfo("Bot stop skipped because loop is not running");
    return;
  }

  runtime.stopping = true;
  logInfo("Bot stop requested");
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

  try {
    manualAuthSession = await startMangabuffManualAuth();
  } catch (error) {
    throw mapManualAuthStartError(error);
  }
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

function mapManualAuthStartError(error: unknown): Error {
  const message = formatError(error);

  if (message.includes("browserType.launch: Executable doesn't exist")) {
    return new HttpError(
      500,
      "Ручная авторизация недоступна: в окружении не установлен Chromium для Playwright. Пересобери Docker-образ с INSTALL_PLAYWRIGHT=true или загрузи готовую сессию в MANGABUFF_STORAGE_STATE_PATH.",
    );
  }

  return error instanceof Error ? error : new Error(message);
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
      ...authRuntime,
      manualAuthActive: Boolean(manualAuthSession),
    },
    trades: listTrades(db, 50),
  };
}

async function buildDiagnostics(): Promise<object> {
  const databasePath = process.env.DATABASE_PATH ?? process.env.DB_PATH ?? "data/baryga-manga.sqlite";
  const storageStateExists = await fileExists(mangabuffStorageStatePath);
  const authorized = storageStateExists ? await checkSavedMangabuffHttpSession().catch(() => false) : false;

  return {
    autoStartBot: process.env.AUTO_START_BOT === "true",
    databasePath,
    databasePathExists: await fileExists(databasePath),
    host: readHostname(),
    mangabuff: {
      authorized,
      hasLogin: Boolean(process.env.MANGABUFF_LOGIN?.trim()),
      hasPassword: Boolean(process.env.MANGABUFF_PASSWORD?.trim()),
      proxyConfigured: Boolean(readMangabuffProxyUrl()),
      storageStateExists,
      storageStatePath: mangabuffStorageStatePath,
    },
    nodeEnv: process.env.NODE_ENV,
    port: readPort(),
    telegram: {
      chatIdConfigured: Boolean(readFirstOptionalEnv(["MANGA_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"])),
      tokenConfigured: Boolean(
        readFirstOptionalEnv(["MANGA_TELEGRAM_BOT_TOKEN", "APP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"]),
      ),
    },
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
  const safeMode = readOptionalBooleanEnv(["BARYGA_SAFE_MODE", "SAFE_MODE"]);
  const autoAcceptEnabled = readOptionalBooleanEnv(["BARYGA_AUTO_ACCEPT_ENABLED", "AUTO_ACCEPT_ENABLED"]);

  if (telegramBotToken) {
    settings.telegramBotToken = telegramBotToken;
  }

  if (telegramChatId) {
    settings.telegramChatId = telegramChatId;
  }

  if (safeMode !== undefined) {
    settings.safeMode = safeMode;
  }

  if (autoAcceptEnabled !== undefined) {
    settings.autoAcceptEnabled = autoAcceptEnabled;
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

function readOptionalBooleanEnv(names: string[]): boolean | undefined {
  const rawValue = readFirstOptionalEnv(names);

  if (!rawValue) {
    return undefined;
  }

  const value = rawValue.toLowerCase();

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`${names[0]} должен быть true или false.`);
}

async function ensureSavedMangabuffSessionAuthorized(): Promise<boolean> {
  logInfo("Checking saved Mangabuff HTTP session");

  if (await checkSavedMangabuffHttpSession()) {
    markAuthAuthorized("saved_session_check");
    return true;
  }

  const credentials = readMangabuffCredentials();

  if (!credentials) {
    logWarn("Saved Mangabuff HTTP session is not authorized and auto-login credentials are missing");
    markAuthUnauthorized("missing_credentials");
    return false;
  }

  logWarn("Saved Mangabuff HTTP session is not authorized; trying auto-login");

  if (!(await runMangabuffAutoLogin(credentials, "startup_auth_check"))) {
    scheduleAuthRecovery("startup_auth_check_failed");
    return false;
  }

  const authorized = await checkSavedMangabuffHttpSession();

  if (authorized) {
    markAuthAuthorized("post_autologin_check");
    return true;
  }

  markAuthUnauthorized("post_autologin_check_failed");
  scheduleAuthRecovery("post_autologin_check_failed");
  return false;
}

function startAutoLoginRefreshLoop(): void {
  const intervalHours = readAutoLoginIntervalHours();

  if (!intervalHours) {
    logInfo("Mangabuff auto-login refresh disabled", {
      MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS: process.env.MANGABUFF_AUTO_LOGIN_INTERVAL_HOURS,
    });
    return;
  }

  const credentials = readMangabuffCredentials();

  if (!credentials) {
    logWarn("Mangabuff auto-login refresh disabled because credentials are missing", {
      hasLogin: Boolean(process.env.MANGABUFF_LOGIN?.trim()),
      hasPassword: Boolean(process.env.MANGABUFF_PASSWORD?.trim()),
    });
    return;
  }

  const intervalMs = intervalHours * 60 * 60 * 1_000;
  const scheduleNext = () => {
    setTimeout(() => {
      void runAutoLoginRefresh(credentials).finally(scheduleNext);
    }, intervalMs);
  };

  logInfo("Mangabuff auto-login refresh scheduled", { intervalHours });
  scheduleNext();
}

async function runAutoLoginRefresh(credentials: MangabuffCredentials): Promise<void> {
  const shouldRestartBot = runtime.running;

  try {
    logInfo("Mangabuff auto-login refresh started", { shouldRestartBot });

    if (shouldRestartBot) {
      stopBot();
      await waitForBotStopped();
    }

    const saved = await runMangabuffAutoLogin(credentials, "scheduled_refresh");

    if (saved && shouldRestartBot) {
      await startBot(db);
      return;
    }

    if (!saved) {
      scheduleAuthRecovery("scheduled_refresh_failed");
    }
  } catch (error) {
    logError("Mangabuff auto-login refresh failed", { error: formatError(error) });
    scheduleAuthRecovery("scheduled_refresh_failed");
  }
}

async function restartBotAfterAuthRequired(db: AppDatabase): Promise<void> {
  const credentials = readMangabuffCredentials();

  if (!credentials) {
    logWarn("Bot stopped because Mangabuff authorization is required; auto-login credentials are missing");
    return;
  }

  logWarn("Bot stopped because Mangabuff authorization is required; trying auto-login restart");

  if (!(await runMangabuffAutoLogin(credentials, "auth_required_restart"))) {
    runtime.lastError = "Автологин Mangabuff не подтвердил авторизацию.";
    markAuthUnauthorized("auth_required_restart_failed");
    scheduleAuthRecovery("auth_required_restart_failed");
    return;
  }

  await startBot(db);
}

async function runMangabuffAutoLogin(
  credentials: MangabuffCredentials,
  reason: "startup_auth_check" | "scheduled_refresh" | "auth_required_restart" | "background_recovery",
): Promise<boolean> {
  if (autoLoginRefreshRunning) {
    logInfo("Mangabuff auto-login skipped because another refresh is running", { reason });
    return false;
  }

  autoLoginRefreshRunning = true;

  try {
    authRuntime.lastAttemptAt = new Date().toISOString();
    logInfo("Mangabuff auto-login started", { reason });
    const saved = await autoLoginMangabuffHttpSession(credentials);
    logInfo("Mangabuff auto-login finished", {
      reason,
      saved,
      time: new Date().toLocaleString("ru-RU"),
    });

    if (saved) {
      markAuthAuthorized("auto_login");
    } else {
      markAuthUnauthorized("auto_login_unconfirmed");
    }

    return saved;
  } catch (error) {
    logError("Mangabuff auto-login failed", { error: formatError(error), reason });
    markAuthUnauthorized(formatError(error));
    return false;
  } finally {
    autoLoginRefreshRunning = false;
  }
}

function readMangabuffCredentials(): MangabuffCredentials | undefined {
  const login = process.env.MANGABUFF_LOGIN?.trim();
  const password = process.env.MANGABUFF_PASSWORD?.trim();

  if (!login || !password) {
    return undefined;
  }

  return { login, password };
}

function logTradesPass(result: TradesPassResult): void {
  if (result.status === "auth_required") {
    markAuthUnauthorized(result.reason);
    scheduleAuthRecovery("bot_pass_auth_required");
    logWarn("Bot pass requires Mangabuff authorization", {
      passNumber: result.passNumber,
      reason: result.reason,
    });
    return;
  }

  if (result.status === "temporary_error") {
    logWarn("Bot pass finished with a temporary error", {
      passNumber: result.passNumber,
      reason: result.reason,
    });
    return;
  }

  logInfo("Bot pass finished", {
    acceptedCount: result.acceptedCount,
    checkErrorCount: result.checkErrorCount,
    insertedCount: result.insertedCount,
    manualReviewCount: result.manualReviewCount,
    pageStaleCount: result.pageStaleCount,
    parsedCount: result.parsedCount,
    pagesCheckedCount: result.pagesCheckedCount,
    passNumber: result.passNumber,
    processedCount: result.processedCount,
    ranksCheckedCount: result.ranksCheckedCount,
    rulesDroppedCount: result.rulesDroppedCount,
    safeAcceptCount: result.safeAcceptCount,
    skippedCount: result.skippedCount,
    skippedStatusSummary: result.skippedStatusSummary,
    skippedTradeIds: result.skippedTradeIds,
    staleCount: result.staleCount,
    visibleCount: result.visibleTrades.length,
    visibleTradePageCount: result.visibleTradePageCount,
    visibleTradeIds: result.visibleTrades.map((trade) => trade.tradeId).join(","),
  });
}

function performDatabaseMaintenance(reason: string): void {
  const result = runDatabaseMaintenance(db);

  if (result.deletedTrades > 0) {
    logInfo("Database maintenance deleted old trades", {
      deletedTrades: result.deletedTrades,
      reason,
      retentionDays: result.retentionDays,
    });
    return;
  }

  logInfo("Database maintenance finished", {
    checkpointMode: result.checkpointMode,
    reason,
    retentionDays: result.retentionDays,
  });
}

async function logStartupDiagnostics(hostname: string, port: number): Promise<void> {
  const webOrigins = readWebOrigins();
  const databasePath = process.env.DATABASE_PATH ?? process.env.DB_PATH ?? "data/baryga-manga.sqlite";
  const storageStateExists = await fileExists(mangabuffStorageStatePath);

  logInfo("Startup diagnostics", {
    AUTO_START_BOT: process.env.AUTO_START_BOT,
    HOST: hostname,
    NODE_ENV: process.env.NODE_ENV,
    PORT: port,
    SAFE_MODE: process.env.SAFE_MODE,
    AUTO_ACCEPT_ENABLED: process.env.AUTO_ACCEPT_ENABLED,
    WEB_ORIGIN: Array.isArray(webOrigins) ? webOrigins.join(",") : webOrigins,
    databasePath,
    hasMangabuffLogin: Boolean(process.env.MANGABUFF_LOGIN?.trim()),
    hasMangabuffPassword: Boolean(process.env.MANGABUFF_PASSWORD?.trim()),
    hasMangabuffProxy: Boolean(readMangabuffProxyUrl()),
    isVercel: process.env.VERCEL === "1" || process.env.VERCEL === "true",
    mangabuffStorageStatePath,
    mangabuffStorageStateExists: storageStateExists,
    telegramBotTokenConfigured: Boolean(
      readFirstOptionalEnv(["MANGA_TELEGRAM_BOT_TOKEN", "APP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"]),
    ),
    telegramChatIdConfigured: Boolean(readFirstOptionalEnv(["MANGA_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"])),
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

function readAuthRetryMinutes(): number {
  const value = process.env.MANGABUFF_AUTH_RETRY_MINUTES?.trim();

  if (!value) {
    return 5;
  }

  const minutes = Number(value);

  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
    throw new Error("MANGABUFF_AUTH_RETRY_MINUTES должен быть числом от 1 до 60.");
  }

  return minutes;
}

function scheduleAuthRecovery(reason: string): void {
  if (authRecoveryTimer) {
    logInfo("Mangabuff auth recovery is already scheduled", { reason });
    return;
  }

  const retryMinutes = readAuthRetryMinutes();
  const retryMs = retryMinutes * 60 * 1_000;
  const scheduledAt = new Date(Date.now() + retryMs).toISOString();

  authRuntime.recoveryScheduledAt = scheduledAt;
  authRecoveryTimer = setTimeout(() => {
    authRecoveryTimer = undefined;
    authRuntime.recoveryScheduledAt = undefined;
    void runAuthRecovery().catch((error) => {
      logError("Mangabuff auth recovery crashed", { error: formatError(error) });
      markAuthUnauthorized(formatError(error));
      scheduleAuthRecovery("background_recovery_crashed");
    });
  }, retryMs);

  logWarn("Mangabuff auth recovery scheduled", {
    reason,
    retryMinutes,
    scheduledAt,
  });
}

async function runAuthRecovery(): Promise<void> {
  const credentials = readMangabuffCredentials();

  if (!credentials) {
    logWarn("Mangabuff auth recovery skipped because credentials are missing");
    markAuthUnauthorized("missing_credentials");
    return;
  }

  logInfo("Mangabuff auth recovery started", {
    autoStartBot: process.env.AUTO_START_BOT === "true",
    botRunning: runtime.running,
  });

  if (await checkSavedMangabuffHttpSession().catch(() => false)) {
    markAuthAuthorized("background_saved_session_check");
    await maybeRestartBotAfterAuthRecovery();
    return;
  }

  const saved = await runMangabuffAutoLogin(credentials, "background_recovery");

  if (!saved) {
    scheduleAuthRecovery("background_recovery_failed");
    return;
  }

  const authorized = await checkSavedMangabuffHttpSession().catch(() => false);

  if (!authorized) {
    markAuthUnauthorized("background_post_autologin_check_failed");
    scheduleAuthRecovery("background_post_autologin_check_failed");
    return;
  }

  markAuthAuthorized("background_post_autologin_check");
  await maybeRestartBotAfterAuthRecovery();
}

async function maybeRestartBotAfterAuthRecovery(): Promise<void> {
  if (process.env.AUTO_START_BOT !== "true" || runtime.running) {
    return;
  }

  logInfo("Mangabuff auth recovery will restart the bot");

  try {
    await startBot(db);
  } catch (error) {
    logError("Mangabuff auth recovery could not restart the bot", { error: formatError(error) });
    scheduleAuthRecovery("background_restart_failed");
  }
}

function markAuthAuthorized(source: string): void {
  if (authRecoveryTimer) {
    clearTimeout(authRecoveryTimer);
    authRecoveryTimer = undefined;
  }

  authRuntime.authorized = true;
  authRuntime.lastFailureReason = undefined;
  authRuntime.recoveryScheduledAt = undefined;
  authRuntime.lastSuccessAt = new Date().toISOString();
  runtime.lastError = runtime.lastError === "Ожидается повторная авторизация Mangabuff." ? undefined : runtime.lastError;
  logInfo("Mangabuff authorization confirmed", { source });
}

function markAuthUnauthorized(reason: string): void {
  authRuntime.authorized = false;
  authRuntime.lastFailureReason = reason;

  if (!runtime.running) {
    runtime.lastError = "Ожидается повторная авторизация Mangabuff.";
  }
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
