import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  cancelMangabuffManualAuth,
  checkMangabuffSession,
  completeMangabuffManualAuth,
  startMangabuffManualAuth,
  type ManualAuthSession,
} from "./browser.js";
import { listTrades, loadSettings, openDatabase, saveSettingsPatch, type AppDatabase } from "./db.js";
import type { BotSettings, TradeRecord } from "./domain.js";
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

const db = openDatabase();
const runtime: RuntimeState = {
  running: false,
  stopping: false,
};
let botAbortController: AbortController | undefined;
let manualAuthSession: ManualAuthSession | undefined;

export function startControlServer(port = readPort()): void {
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;

      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Панель управления: http://127.0.0.1:${port}`);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, renderAppHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, buildState(db));
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJsonBody(request);
    const patch = parseSettingsPatch(body);
    const settings = saveSettingsPatch(db, patch);
    sendJson(response, 200, sanitizeSettings(settings));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bot/start") {
    await startBot(db);
    sendJson(response, 200, buildState(db));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bot/stop") {
    stopBot();
    sendJson(response, 200, buildState(db));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/start") {
    await startManualAuth();
    sendJson(response, 200, { active: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/complete") {
    const saved = await completeManualAuth();
    sendJson(response, saved ? 200 : 400, { saved });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/cancel") {
    await cancelManualAuth();
    sendJson(response, 200, { active: false });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    const settings = loadRuntimeSettings(db);
    const authorized = await checkMangabuffSession(settings);
    sendJson(response, 200, { authorized });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function startBot(db: AppDatabase): Promise<void> {
  if (runtime.running) {
    return;
  }

  const settings = loadRuntimeSettings(db);
  settings.safeMode = true;
  settings.autoAcceptEnabled = false;
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

  settings.safeMode = true;
  settings.autoAcceptEnabled = false;

  return settings;
}

function sanitizeSettings(settings: BotSettings): object {
  return {
    telegramConfigured: Boolean(settings.telegramBotToken && settings.telegramChatId),
    telegramChatId: maskSecret(settings.telegramChatId),
    safeMode: true,
    autoAcceptEnabled: false,
    autoAcceptLocked: true,
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

  if (source.safeMode === false || source.autoAcceptEnabled === true) {
    throw new HttpError(400, "Автопринятие пока заблокировано до отдельного тестирования.");
  }

  patch.safeMode = true;
  patch.autoAcceptEnabled = false;

  return patch;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";

  for await (const chunk of request) {
    body += chunk;
  }

  if (!body.trim()) {
    return {};
  }

  return JSON.parse(body) as unknown;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
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

function renderAppHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Обмены Mangabuff</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #667085;
      --line: #d9dee7;
      --accent: #176b87;
      --accent-strong: #0f5168;
      --danger: #b42318;
      --warning: #b76e00;
      --ok: #16794c;
      --soft: #edf5f7;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }

    button, input, select {
      font: inherit;
    }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 280px 1fr;
    }

    aside {
      border-right: 1px solid var(--line);
      background: #fbfcfd;
      padding: 22px 18px;
    }

    main {
      padding: 22px;
      min-width: 0;
    }

    h1 {
      margin: 0 0 4px;
      font-size: 21px;
      line-height: 1.2;
    }

    h2 {
      margin: 0 0 12px;
      font-size: 15px;
    }

    .subtle {
      color: var(--muted);
      font-size: 13px;
    }

    .stack {
      display: grid;
      gap: 16px;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }

    .controls {
      display: grid;
      gap: 10px;
      margin-top: 16px;
    }

    .field {
      display: grid;
      gap: 6px;
    }

    label {
      color: #344054;
      font-weight: 600;
      font-size: 12px;
    }

    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      background: #fff;
      color: var(--ink);
    }

    input:disabled {
      background: #f1f3f6;
      color: var(--muted);
    }

    button {
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      padding: 9px 12px;
      cursor: pointer;
      font-weight: 650;
    }

    button.secondary {
      background: #fff;
      color: var(--accent);
    }

    button.danger {
      border-color: var(--danger);
      background: var(--danger);
    }

    button:disabled {
      border-color: #c8ced8;
      background: #e4e8ef;
      color: #7a8494;
      cursor: not-allowed;
    }

    .status-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--muted);
      flex: 0 0 auto;
    }

    .dot.ok {
      background: var(--ok);
    }

    .dot.warn {
      background: var(--warning);
    }

    .dot.bad {
      background: var(--danger);
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      justify-content: space-between;
      margin-bottom: 14px;
    }

    .toolbar-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }

    .metric {
      background: var(--soft);
      border: 1px solid #cfe2e8;
      border-radius: 8px;
      padding: 12px;
      min-width: 0;
    }

    .metric strong {
      display: block;
      font-size: 20px;
      line-height: 1.1;
    }

    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }

    table {
      width: 100%;
      min-width: 980px;
      border-collapse: collapse;
    }

    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f8fafc;
      color: #475467;
      font-size: 12px;
      white-space: nowrap;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
      font-weight: 700;
      background: #eef2f6;
      color: #344054;
      white-space: nowrap;
    }

    .badge.good {
      background: #e8f5ee;
      color: var(--ok);
    }

    .badge.bad {
      background: #fdecec;
      color: var(--danger);
    }

    .badge.warn {
      background: #fff4df;
      color: var(--warning);
    }

    .cards {
      max-width: 280px;
      color: #344054;
    }

    .reason {
      max-width: 360px;
      color: #344054;
    }

    .notice {
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid #f4d19b;
      border-radius: 8px;
      background: #fff8eb;
      color: #6f4500;
    }

    .error {
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid #f0b5b1;
      border-radius: 8px;
      background: #fff1f0;
      color: var(--danger);
    }

    @media (max-width: 900px) {
      .shell {
        grid-template-columns: 1fr;
      }

      aside {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Обмены Mangabuff</h1>
      <div class="subtle">Локальная панель безопасной проверки</div>

      <div class="status-line" id="botStatus">
        <span class="dot"></span>
        <span>Загрузка состояния</span>
      </div>

      <div class="notice">
        Автопринятие временно заблокировано. Панель запускает только режим проверки без нажатия кнопки принятия.
      </div>

      <div class="controls">
        <button id="startBot">Запустить бота</button>
        <button id="stopBot" class="danger">Остановить бота</button>
        <button id="refresh" class="secondary">Обновить</button>
      </div>

      <div class="panel" style="margin-top:16px">
        <h2>Авторизация</h2>
        <div class="controls">
          <button id="startAuth" class="secondary">Открыть вход Mangabuff</button>
          <button id="completeAuth">Сохранить сессию</button>
          <button id="checkAuth" class="secondary">Проверить вход</button>
        </div>
        <div id="authMessage" class="subtle" style="margin-top:10px"></div>
      </div>
    </aside>

    <main class="stack">
      <section class="panel">
        <div class="toolbar">
          <div>
            <h2>Настройки</h2>
            <div class="subtle">Секрет Telegram не показывается после сохранения.</div>
          </div>
          <button id="saveSettings">Сохранить настройки</button>
        </div>
        <div class="summary">
          <div class="field">
            <label for="maxPages">Максимум страниц желающих</label>
            <input id="maxPages" type="number" min="1" max="100" step="1">
          </div>
          <div class="field">
            <label for="pauseMs">Пауза между проходами, мс</label>
            <input id="pauseMs" type="number" min="1000" max="10000" step="500">
          </div>
          <div class="field">
            <label for="browserMode">Режим браузера</label>
            <select id="browserMode">
              <option value="headless">Скрытый</option>
              <option value="headful">Видимый</option>
            </select>
          </div>
          <div class="field">
            <label for="autoAccept">Автопринятие</label>
            <input id="autoAccept" value="Заблокировано до тестов" disabled>
          </div>
        </div>
        <div class="summary">
          <div class="field">
            <label for="telegramToken">Telegram bot token</label>
            <input id="telegramToken" type="password" autocomplete="off" placeholder="Оставь пустым, чтобы не менять">
          </div>
          <div class="field">
            <label for="telegramChat">Telegram chat ID</label>
            <input id="telegramChat" autocomplete="off" placeholder="Оставь пустым, чтобы не менять">
          </div>
          <div class="field">
            <label>Telegram</label>
            <input id="telegramStatus" disabled>
          </div>
          <div class="field">
            <label>Режим проверки</label>
            <input value="Только проверять, не принимать" disabled>
          </div>
        </div>
        <div id="settingsMessage"></div>
      </section>

      <section>
        <div class="toolbar">
          <div>
            <h2>Последние обмены</h2>
            <div class="subtle" id="lastPass">История загружается</div>
          </div>
          <div class="toolbar-actions">
            <span class="badge" id="tradeCount">0 записей</span>
          </div>
        </div>

        <div class="summary">
          <div class="metric"><span class="subtle">Всего в списке</span><strong id="metricTotal">0</strong></div>
          <div class="metric"><span class="subtle">Требуют внимания</span><strong id="metricProblems">0</strong></div>
          <div class="metric"><span class="subtle">Бот бы принял</span><strong id="metricWouldAccept">0</strong></div>
          <div class="metric"><span class="subtle">Ошибки проверки</span><strong id="metricErrors">0</strong></div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Обмен</th>
                <th>Статус</th>
                <th>Пользователь</th>
                <th>Забирают</th>
                <th>Предлагают</th>
                <th>Страницы</th>
                <th>Ранги</th>
                <th>Причина</th>
                <th>Обновлён</th>
              </tr>
            </thead>
            <tbody id="tradesBody"></tbody>
          </table>
        </div>
      </section>
    </main>
  </div>

  <script>
    const elements = {
      botStatus: document.getElementById("botStatus"),
      startBot: document.getElementById("startBot"),
      stopBot: document.getElementById("stopBot"),
      refresh: document.getElementById("refresh"),
      startAuth: document.getElementById("startAuth"),
      completeAuth: document.getElementById("completeAuth"),
      checkAuth: document.getElementById("checkAuth"),
      authMessage: document.getElementById("authMessage"),
      maxPages: document.getElementById("maxPages"),
      pauseMs: document.getElementById("pauseMs"),
      browserMode: document.getElementById("browserMode"),
      telegramToken: document.getElementById("telegramToken"),
      telegramChat: document.getElementById("telegramChat"),
      telegramStatus: document.getElementById("telegramStatus"),
      saveSettings: document.getElementById("saveSettings"),
      settingsMessage: document.getElementById("settingsMessage"),
      lastPass: document.getElementById("lastPass"),
      tradeCount: document.getElementById("tradeCount"),
      metricTotal: document.getElementById("metricTotal"),
      metricProblems: document.getElementById("metricProblems"),
      metricWouldAccept: document.getElementById("metricWouldAccept"),
      metricErrors: document.getElementById("metricErrors"),
      tradesBody: document.getElementById("tradesBody"),
    };

    let state = null;

    async function request(path, options = {}) {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Запрос не выполнен");
      }

      return payload;
    }

    async function loadState() {
      state = await request("/api/state");
      renderState();
    }

    function renderState() {
      renderRuntime(state.runtime);
      renderSettings(state.settings);
      renderTrades(state.trades);
    }

    function renderRuntime(runtime) {
      const dot = elements.botStatus.querySelector(".dot");
      const text = elements.botStatus.querySelector("span:last-child");
      dot.className = "dot";

      if (runtime.running) {
        dot.classList.add(runtime.stopping ? "warn" : "ok");
        text.textContent = runtime.stopping ? "Бот останавливается" : "Бот работает";
      } else if (runtime.lastError) {
        dot.classList.add("bad");
        text.textContent = "Бот остановлен с ошибкой";
      } else {
        text.textContent = "Бот остановлен";
      }

      elements.startBot.disabled = runtime.running;
      elements.stopBot.disabled = !runtime.running;

      if (runtime.lastPass?.status === "ok") {
        elements.lastPass.textContent =
          "Последний проход #" + runtime.lastPass.passNumber +
          ": видимых " + runtime.lastPass.visibleTrades.length +
          ", ручная проверка " + runtime.lastPass.manualReviewCount +
          ", ошибок " + runtime.lastPass.checkErrorCount + ".";
      } else if (runtime.lastPass?.status === "temporary_error") {
        elements.lastPass.textContent = "Последний проход: временная ошибка. " + runtime.lastPass.reason;
      } else if (runtime.lastPass?.status === "auth_required") {
        elements.lastPass.textContent = "Последний проход: нужна повторная авторизация Mangabuff.";
      } else if (runtime.lastError) {
        elements.lastPass.textContent = runtime.lastError;
      } else {
        elements.lastPass.textContent = "Проходов ещё не было.";
      }
    }

    function renderSettings(settings) {
      elements.maxPages.value = settings.maxWantedPagesExclusive;
      elements.pauseMs.value = settings.loopPauseMs;
      elements.browserMode.value = settings.browserMode;
      elements.telegramStatus.value = settings.telegramConfigured
        ? "настроен" + (settings.telegramChatId ? " (" + settings.telegramChatId + ")" : "")
        : "не настроен";
    }

    function renderTrades(trades) {
      elements.tradeCount.textContent = trades.length + " записей";
      elements.metricTotal.textContent = trades.length;
      elements.metricProblems.textContent = trades.filter((trade) =>
        trade.status === "требует_ручной_проверки" || trade.status === "брошен_по_правилам"
      ).length;
      elements.metricWouldAccept.textContent = trades.filter((trade) => trade.status === "бот_бы_принял").length;
      elements.metricErrors.textContent = trades.filter((trade) => trade.status === "ошибка_проверки").length;

      elements.tradesBody.replaceChildren(...trades.map(renderTradeRow));
    }

    function renderTradeRow(trade) {
      const row = document.createElement("tr");
      row.innerHTML = [
        "<td><a href=\\"" + escapeHtml(trade.tradeUrl) + "\\" target=\\"_blank\\" rel=\\"noreferrer\\">#" + escapeHtml(trade.tradeId) + "</a></td>",
        "<td>" + renderStatus(trade.status) + "</td>",
        "<td>" + escapeHtml(trade.senderName || "не удалось определить") + "</td>",
        "<td class=\\"cards\\">" + escapeHtml(formatCards(trade.requestedCards)) + "</td>",
        "<td class=\\"cards\\">" + escapeHtml(formatCards(trade.offeredCards)) + "</td>",
        "<td>" + escapeHtml(trade.wantedPagesCount ?? "не проверялось") + "</td>",
        "<td>" + escapeHtml(formatRankRule(trade.rankRuleResult)) + "</td>",
        "<td class=\\"reason\\">" + escapeHtml(trade.reason || "не указана") + "</td>",
        "<td>" + escapeHtml(formatDate(trade.updatedAt)) + "</td>",
      ].join("");
      return row;
    }

    function renderStatus(status) {
      let tone = "";

      if (status === "бот_бы_принял" || status === "принят") {
        tone = " good";
      } else if (status === "требует_ручной_проверки" || status === "брошен_по_правилам") {
        tone = " bad";
      } else if (status === "ошибка_проверки") {
        tone = " warn";
      }

      return "<span class=\\"badge" + tone + "\\">" + escapeHtml(status) + "</span>";
    }

    function formatCards(cards) {
      if (!cards || cards.length === 0) {
        return "не удалось определить";
      }

      return cards.map((card) => {
        const title = card.title || "карта";
        const rank = card.rank ? ", ранг " + card.rank : "";
        return title + " #" + card.cardId + rank;
      }).join(", ");
    }

    function formatRankRule(value) {
      if (value === "выполнено") return "выполнено";
      if (value === "не_выполнено") return "не выполнено";
      return "не проверялось";
    }

    function formatDate(value) {
      if (!value) return "не указано";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU");
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\\"", "&quot;")
        .replaceAll("'", "&#039;");
    }

    function showMessage(target, text, kind = "notice") {
      target.className = kind;
      target.textContent = text;
    }

    elements.startBot.addEventListener("click", async () => {
      try {
        await request("/api/bot/start", { method: "POST" });
        await loadState();
      } catch (error) {
        showMessage(elements.settingsMessage, error.message, "error");
      }
    });

    elements.stopBot.addEventListener("click", async () => {
      await request("/api/bot/stop", { method: "POST" });
      await loadState();
    });

    elements.refresh.addEventListener("click", loadState);

    elements.saveSettings.addEventListener("click", async () => {
      try {
        await request("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({
            maxWantedPagesExclusive: Number(elements.maxPages.value),
            loopPauseMs: Number(elements.pauseMs.value),
            browserMode: elements.browserMode.value,
            telegramBotToken: elements.telegramToken.value,
            telegramChatId: elements.telegramChat.value,
          }),
        });
        elements.telegramToken.value = "";
        showMessage(elements.settingsMessage, "Настройки сохранены.");
        await loadState();
      } catch (error) {
        showMessage(elements.settingsMessage, error.message, "error");
      }
    });

    elements.startAuth.addEventListener("click", async () => {
      try {
        await request("/api/auth/start", { method: "POST" });
        elements.authMessage.textContent = "Открыто видимое окно Mangabuff. Войди вручную и нажми “Сохранить сессию”.";
      } catch (error) {
        elements.authMessage.textContent = error.message;
      }
    });

    elements.completeAuth.addEventListener("click", async () => {
      try {
        await request("/api/auth/complete", { method: "POST" });
        elements.authMessage.textContent = "Сессия Mangabuff сохранена.";
      } catch (error) {
        elements.authMessage.textContent = error.message;
      }
    });

    elements.checkAuth.addEventListener("click", async () => {
      try {
        const result = await request("/api/auth/status");
        elements.authMessage.textContent = result.authorized ? "Сессия активна." : "Нужна авторизация Mangabuff.";
      } catch (error) {
        elements.authMessage.textContent = error.message;
      }
    });

    loadState().catch((error) => {
      showMessage(elements.settingsMessage, error.message, "error");
    });
    setInterval(() => {
      loadState().catch(() => undefined);
    }, 2500);
  </script>
</body>
</html>`;
}
