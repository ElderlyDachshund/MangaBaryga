import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cancelMangabuffManualAuth,
  checkMangabuffSession,
  completeMangabuffManualAuth,
  startMangabuffManualAuth,
  type ManualAuthSession,
} from "./browser.js";
import { listTrades, loadSettings, openDatabase, saveSettingsPatch, type AppDatabase } from "./db.js";
import type { BotSettings } from "./domain.js";
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
    void startBot(db).catch((error) => {
      console.error(
        `Не удалось автоматически запустить бота: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

function createControlApp(): Hono {
  const app = new Hono();

  app.onError((error) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;

    return jsonResponse(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      statusCode,
    );
  });

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
    const settings = loadRuntimeSettings(db);
    const authorized = await checkMangabuffSession(settings);

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

  const authorized = await checkMangabuffSession(settings);

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
    return;
  }

  manualAuthSession = await startMangabuffManualAuth();
}

async function completeManualAuth(): Promise<boolean> {
  if (!manualAuthSession) {
    throw new HttpError(400, "Окно авторизации не запущено.");
  }

  const saved = await completeMangabuffManualAuth(manualAuthSession);

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
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim();

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
  const port = Number(process.env.PORT ?? 3017);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PORT должен быть целым числом от 1 до 65535.");
  }

  return port;
}

function readHostname(): string {
  return process.env.HOST?.trim() || "127.0.0.1";
}
