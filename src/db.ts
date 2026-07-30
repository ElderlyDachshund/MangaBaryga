import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDefaultSettings, type BotSettings, type RankRuleResult, type TradeRecord, type TradeStatus } from "./domain.js";

const schemaSql = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  trade_url TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  sender_name TEXT,
  requested_cards_json TEXT NOT NULL DEFAULT '[]',
  offered_cards_json TEXT NOT NULL DEFAULT '[]',
  wanted_pages_count INTEGER,
  rank_rule_result TEXT NOT NULL DEFAULT 'не_проверялось',
  check_attempts INTEGER NOT NULL DEFAULT 0,
  accept_attempts INTEGER NOT NULL DEFAULT 0,
  last_accept_attempted_at TEXT,
  telegram_sent INTEGER NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_detail_checked_at TEXT,
  missing_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_updated_at ON trades(updated_at);
`;

interface TradeRow {
  trade_id: string;
  trade_url: string;
  status: TradeRecord["status"];
  reason: string;
  sender_name?: string;
  requested_cards_json: string;
  offered_cards_json: string;
  wanted_pages_count?: number;
  rank_rule_result: RankRuleResult;
  check_attempts: number;
  accept_attempts: number;
  last_accept_attempted_at?: string;
  telegram_sent: 0 | 1;
  discovered_at: string;
  last_seen_at: string;
  last_detail_checked_at?: string;
  missing_at?: string;
  updated_at: string;
}

interface SettingRow {
  key: string;
  value: string;
}

export type AppDatabase = Database.Database;

const defaultTradeRetentionDays = 30;

export function openDatabase(
  path = process.env.DATABASE_PATH ?? process.env.DB_PATH ?? "data/baryga-manga.sqlite",
): AppDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_size_limit = 5242880");
  db.exec(schemaSql);
  migrateDatabase(db);
  return db;
}

export function insertNewTrade(db: AppDatabase, tradeId: string, tradeUrl: string): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO trades (trade_id, trade_url, status, reason)
     VALUES (?, ?, 'новое', '')`,
  ).run(tradeId, tradeUrl);

  return result.changes > 0;
}

export function markVisibleTradesSeen(db: AppDatabase, visibleTradeIds: string[]): number {
  if (visibleTradeIds.length === 0) {
    return 0;
  }

  const placeholders = visibleTradeIds.map(() => "?").join(", ");
  return db
    .prepare(
      `UPDATE trades
       SET last_seen_at = CURRENT_TIMESTAMP,
           missing_at = NULL
       WHERE trade_id IN (${placeholders})`,
    )
    .run(...visibleTradeIds).changes;
}

export function markMissingTradesAsStale(db: AppDatabase, visibleTradeIds: string[]): number {
  const staleStatuses = ["новое", "ошибка_проверки"] satisfies TradeStatus[];
  const staleReason = 'Обмен исчез из вкладки "Предложения".';
  const statusPlaceholders = staleStatuses.map(() => "?").join(", ");
  const visiblePlaceholders = visibleTradeIds.map(() => "?").join(", ");
  const visibleCondition =
    visibleTradeIds.length > 0 ? `AND trade_id NOT IN (${visiblePlaceholders})` : "";

  db.prepare(
    `UPDATE trades
     SET missing_at = COALESCE(missing_at, CURRENT_TIMESTAMP)
     WHERE 1 = 1
     ${visibleCondition}`,
  ).run(...visibleTradeIds);

  const result = db.prepare(
    `UPDATE trades
     SET status = 'неактуален',
         reason = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE status IN (${statusPlaceholders})
       AND missing_at IS NOT NULL`,
  ).run(staleReason, ...staleStatuses);

  return result.changes;
}

export function recordTradeDetailCheck(db: AppDatabase, tradeId: string): boolean {
  const result = db.prepare(
    `UPDATE trades
     SET last_detail_checked_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?`,
  ).run(tradeId);

  return result.changes > 0;
}

export function updateTradeStatus(
  db: AppDatabase,
  tradeId: string,
  status: TradeStatus,
  reason: string,
): boolean {
  const result = db.prepare(
    `UPDATE trades
     SET status = ?,
         reason = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?`,
  ).run(status, reason, tradeId);

  return result.changes > 0;
}

export function updateTradeParsedData(
  db: AppDatabase,
  tradeId: string,
  data: Pick<TradeRecord, "senderName" | "requestedCards" | "offeredCards"> & {
    reason: string;
  },
): boolean {
  const result = db.prepare(
    `UPDATE trades
     SET status = 'новое',
         reason = ?,
         sender_name = ?,
         requested_cards_json = ?,
         offered_cards_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?`,
  ).run(
    data.reason,
    data.senderName ?? null,
    JSON.stringify(data.requestedCards),
    JSON.stringify(data.offeredCards),
    tradeId,
  );

  return result.changes > 0;
}

export function updateTradeWantedPagesCount(
  db: AppDatabase,
  tradeId: string,
  wantedPagesCount: number,
  reason: string,
): boolean {
  const result = db.prepare(
    `UPDATE trades
     SET wanted_pages_count = ?,
         reason = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?`,
  ).run(wantedPagesCount, reason, tradeId);

  return result.changes > 0;
}

export function updateTradeRankRuleResult(
  db: AppDatabase,
  tradeId: string,
  rankRuleResult: RankRuleResult,
  reason: string,
): boolean {
  const result = db.prepare(
    `UPDATE trades
     SET rank_rule_result = ?,
         reason = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?`,
  ).run(rankRuleResult, reason, tradeId);

  return result.changes > 0;
}

export function recordTradeAcceptAttempt(db: AppDatabase, tradeId: string): boolean {
  const result = db.prepare(
    `UPDATE trades
     SET accept_attempts = accept_attempts + 1,
         last_accept_attempted_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?`,
  ).run(tradeId);

  return result.changes > 0;
}

export function markTradeTelegramSent(db: AppDatabase, tradeId: string): boolean {
  const result = db.prepare(
    `UPDATE trades
     SET telegram_sent = 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?
       AND telegram_sent = 0`,
  ).run(tradeId);

  return result.changes > 0;
}

export function recordTradeCheckFailure(db: AppDatabase, tradeId: string, reason: string): TradeStatus {
  const existing = findTradeById(db, tradeId);
  const nextAttemptCount = (existing?.checkAttempts ?? 0) + 1;
  const status = nextAttemptCount >= 2 ? "требует_ручной_проверки" : "ошибка_проверки";
  const finalReason =
    status === "требует_ручной_проверки"
      ? `${reason} Повторная проверка тоже не удалась.`
      : reason;

  db.prepare(
    `UPDATE trades
     SET status = ?,
         reason = ?,
         check_attempts = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE trade_id = ?`,
  ).run(status, finalReason, nextAttemptCount, tradeId);

  return status;
}

export function loadSettings(db: AppDatabase): BotSettings {
  const settings = createDefaultSettings();
  const rows = db.prepare("SELECT key, value FROM settings").all() as SettingRow[];

  for (const row of rows) {
    applyStoredSetting(settings, row.key, row.value);
  }

  return settings;
}

export function saveSettingsPatch(db: AppDatabase, patch: Partial<BotSettings>): BotSettings {
  const allowedKeys = new Set<keyof BotSettings>([
    "telegramBotToken",
    "telegramChatId",
    "safeMode",
    "autoAcceptEnabled",
    "maxWantedPagesExclusive",
    "lockAllWantedPagesThreshold",
    "lockRecentWantedPagesThreshold",
    "lockRecentCardsLimit",
    "loopPauseMs",
    "browserMode",
    "rankRecognitionVerified",
  ]);
  const statement = db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`,
  );

  for (const [key, value] of Object.entries(patch) as Array<[keyof BotSettings, BotSettings[keyof BotSettings]]>) {
    if (!allowedKeys.has(key) || value === undefined) {
      continue;
    }

    statement.run(key, JSON.stringify(value));
  }

  return loadSettings(db);
}

export function listTrades(db: AppDatabase, limit = 20): TradeRecord[] {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = db.prepare(
    `SELECT *
     FROM trades
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(safeLimit) as TradeRow[];

  return rows.map(mapTradeRow);
}

export function findTradeById(db: AppDatabase, tradeId: string): TradeRecord | undefined {
  const row = db.prepare("SELECT * FROM trades WHERE trade_id = ?").get(tradeId) as
    | TradeRow
    | undefined;

  if (!row) {
    return undefined;
  }

  return mapTradeRow(row);
}

export function runDatabaseMaintenance(
  db: AppDatabase,
  options: { retentionDays?: number } = {},
): { checkpointMode: string; deletedTrades: number; retentionDays: number } {
  const retentionDays = normalizeTradeRetentionDays(options.retentionDays);
  const deletedTrades =
    retentionDays > 0
      ? db
          .prepare(
            `DELETE FROM trades
             WHERE updated_at < datetime('now', ?)
               AND missing_at IS NOT NULL`,
          )
          .run(`-${retentionDays} days`).changes
      : 0;

  // Truncate the WAL file so SQLite does not keep growing temporary disk usage.
  db.pragma("wal_checkpoint(TRUNCATE)");

  return {
    checkpointMode: "TRUNCATE",
    deletedTrades,
    retentionDays,
  };
}

function mapTradeRow(row: TradeRow): TradeRecord {
  return {
    tradeId: row.trade_id,
    tradeUrl: row.trade_url,
    status: row.status,
    reason: row.reason,
    senderName: row.sender_name,
    requestedCards: JSON.parse(row.requested_cards_json) as TradeRecord["requestedCards"],
    offeredCards: JSON.parse(row.offered_cards_json) as TradeRecord["offeredCards"],
    wantedPagesCount: row.wanted_pages_count,
    rankRuleResult: row.rank_rule_result,
    checkAttempts: row.check_attempts,
    acceptAttempts: row.accept_attempts,
    lastAcceptAttemptedAt: row.last_accept_attempted_at,
    telegramSent: row.telegram_sent === 1,
    discoveredAt: row.discovered_at,
    lastSeenAt: row.last_seen_at,
    lastDetailCheckedAt: row.last_detail_checked_at ?? undefined,
    missingAt: row.missing_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function applyStoredSetting(settings: BotSettings, key: string, value: string): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }

  switch (key) {
    case "telegramBotToken":
      if (typeof parsed === "string") {
        settings.telegramBotToken = parsed;
      }
      break;
    case "telegramChatId":
      if (typeof parsed === "string") {
        settings.telegramChatId = parsed;
      }
      break;
    case "safeMode":
      if (typeof parsed === "boolean") {
        settings.safeMode = parsed;
      }
      break;
    case "autoAcceptEnabled":
      if (typeof parsed === "boolean") {
        settings.autoAcceptEnabled = parsed;
      }
      break;
    case "maxWantedPagesExclusive":
      if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
        settings.maxWantedPagesExclusive = parsed;
      }
      break;
    case "lockAllWantedPagesThreshold":
      if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
        settings.lockAllWantedPagesThreshold = parsed;
      }
      break;
    case "lockRecentWantedPagesThreshold":
      if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
        settings.lockRecentWantedPagesThreshold = parsed;
      }
      break;
    case "lockRecentCardsLimit":
      if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
        settings.lockRecentCardsLimit = parsed;
      }
      break;
    case "loopPauseMs":
      if (typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 5_000 && parsed <= 15_000) {
        settings.loopPauseMs = parsed;
      }
      break;
    case "browserMode":
      if (parsed === "headless" || parsed === "headful") {
        settings.browserMode = parsed;
      }
      break;
    case "rankRecognitionVerified":
      if (typeof parsed === "boolean") {
        settings.rankRecognitionVerified = parsed;
      }
      break;
  }
}

function migrateDatabase(db: AppDatabase): void {
  ensureColumn(db, "trades", "rank_rule_result", "TEXT NOT NULL DEFAULT 'не_проверялось'");
  ensureColumn(db, "trades", "telegram_sent", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "trades", "last_accept_attempted_at", "TEXT");
  ensureColumn(db, "trades", "last_seen_at", "TEXT");
  ensureColumn(db, "trades", "last_detail_checked_at", "TEXT");
  ensureColumn(db, "trades", "missing_at", "TEXT");
  db.prepare(
    `UPDATE trades
     SET last_seen_at = COALESCE(last_seen_at, discovered_at, CURRENT_TIMESTAMP)
     WHERE last_seen_at IS NULL`,
  ).run();
  backfillRankRuleResults(db);
}

function ensureColumn(
  db: AppDatabase,
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`).run();
}

function backfillRankRuleResults(db: AppDatabase): void {
  db.prepare(
    `UPDATE trades
     SET rank_rule_result = 'выполнено'
     WHERE rank_rule_result = 'не_проверялось'
       AND reason LIKE '%ранговое правило выполнено%'`,
  ).run();

  db.prepare(
    `UPDATE trades
     SET rank_rule_result = 'не_выполнено'
     WHERE rank_rule_result = 'не_проверялось'
       AND reason LIKE 'Ранговое правило не выполнено:%'`,
  ).run();
}

function normalizeTradeRetentionDays(value: number | undefined): number {
  const source = value ?? readTradeRetentionDaysFromEnv();

  if (source === undefined || !Number.isFinite(source) || source <= 0) {
    return defaultTradeRetentionDays;
  }

  return Math.max(1, Math.min(Math.trunc(source), 365));
}

function readTradeRetentionDaysFromEnv(): number | undefined {
  const value = process.env.TRADE_RETENTION_DAYS?.trim();

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
