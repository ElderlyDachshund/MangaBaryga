import type { Locator, Page } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import {
  findTradeById,
  insertNewTrade,
  markTradeTelegramSent,
  markMissingTradesAsStale,
  markVisibleTradesSeen,
  recordTradeAcceptAttempt,
  recordTradeCheckFailure,
  recordTradeDetailCheck,
  updateTradeParsedData,
  updateTradeRankRuleResult,
  updateTradeStatus,
  updateTradeWantedPagesCount,
  type AppDatabase,
} from "./db.js";
import {
  mangabuffTradesUrl,
  isMangabuffAuthorized,
  openSavedMangabuffSession,
  saveBrowserSessionState,
  type BrowserSession,
} from "./browser.js";
import {
  addPositiveJitterMs,
  addSymmetricJitterMs,
  assertMangabuffPageReady,
  clickVerified,
  MangabuffInteractionBlockedError,
  type MangabuffInterruption,
  performIdlePageActivity,
  waitForMangabuffCaptchaToClear,
} from "./browser-safety.js";
import {
  isMangabuffAuthorizedHttpResponse,
  openSavedMangabuffHttpSession,
  type MangabuffSessionClient,
  type MangabuffTextResponse,
} from "./mangabuff-http.js";
import type { BotSettings, CardRank, TradeStatus } from "./domain.js";
import { isFinalTradeStatus, type TradeCard, type TradeRecord } from "./domain.js";
import {
  isSupportedCardRank,
  recognizeCardPageRank,
  recognizeCardRankFromImage,
  recognizeCardRankFromImageBytes,
} from "./ranks.js";
import { passesDefaultRankRule, passesWantedPagesRule } from "./rules.js";
import { logInfo, logWarn } from "./logger.js";
import {
  sendAuthRequiredNotification,
  sendCaptchaNotification,
  sendTradeProblemNotification,
} from "./telegram.js";
import { buildWantedOffersUrl, countWantedUsersPagesFromHtml } from "./wanted-pages.js";

const tradePassTimeoutMs = readIntegerEnv("MANGABUFF_TRADE_PASS_TIMEOUT_MS", 3_600_000, 45_000, 3_600_000);
const tradePauseMinMs = readIntegerEnv("MANGABUFF_TRADE_PAUSE_MIN_MS", 10_000, 0, 60_000);
const tradePauseMaxMs = readIntegerEnv("MANGABUFF_TRADE_PAUSE_MAX_MS", 15_000, 0, 60_000);
const tradeListMaxPages = readIntegerEnv("MANGABUFF_TRADE_LIST_MAX_PAGES", 10, 1, 50);
// 0 means "no per-pass cap": every due trade is opened, still spaced by the trade pauses.
const maxTradeDetailsPerPass = readIntegerEnv("MANGABUFF_TRADE_DETAILS_PER_PASS", 0, 0, 500);
const unchangedTradeDetailCooldownMs = readIntegerEnv(
  "MANGABUFF_TRADE_DETAIL_COOLDOWN_MS",
  24 * 60 * 60 * 1_000,
  60_000,
  7 * 24 * 60 * 60 * 1_000,
);
const backgroundPageIntervals = [
  { intervalMs: 3 * 60_000, url: "https://mangabuff.ru/feed" },
  { intervalMs: 10 * 60_000, url: "https://mangabuff.ru/" },
  { intervalMs: 20 * 60_000, url: "https://mangabuff.ru/manga" },
] as const;
const backgroundPageJitterFraction = 0.25;
// A trade detail is at most three steps deep: offers → trade → card → "Хотят получить".
const maxHistoryBackSteps = 5;
// The offers index is left after every pass, so the pause is spent on another page.
const offersPauseJitterFraction = readFloatEnv("MANGABUFF_OFFERS_PAUSE_JITTER_FRACTION", 1, 0, 3);

export interface VisibleTrade {
  tradeId: string;
  tradeUrl: string;
}

export interface ScanTradesResult {
  visibleTrades: VisibleTrade[];
  insertedCount: number;
  staleCount: number;
  processedCount: number;
  parsedCount: number;
  manualReviewCount: number;
  checkErrorCount: number;
  pageStaleCount: number;
  pagesCheckedCount: number;
  rulesDroppedCount: number;
  ranksCheckedCount: number;
  safeAcceptCount: number;
  acceptedCount: number;
  skippedCount: number;
  skippedStatusSummary?: string;
  skippedTradeIds?: string;
  visibleTradePageCount?: number;
}

export interface TradesLoopOptions {
  getSettings?: () => BotSettings;
  signal?: AbortSignal;
  onPass?: (result: TradesPassResult) => void;
}

export type BotSettingsSource = BotSettings | (() => BotSettings);

export interface BackgroundPageScheduleEntry {
  intervalMs: number;
  nextVisitAt: number;
  url: string;
}

export type TradesPassResult =
  | (ScanTradesResult & {
      status: "ok";
      passNumber: number;
    })
  | {
      status: "temporary_error";
      passNumber: number;
      reason: string;
    }
  | {
      status: "auth_required";
      passNumber: number;
      reason: string;
    }
  | {
      status: "blocked";
      passNumber: number;
      reason: string;
      interruption: MangabuffInterruption;
    };

export async function scanVisibleTrades(
  db: AppDatabase,
  settings: BotSettings,
): Promise<ScanTradesResult> {
  const session = await openSavedMangabuffSession(settings);

  try {
    const result = await scanVisibleTradesInSession(db, session, settings);
    await saveBrowserSessionState(session).catch(() => {});
    return result;
  } catch (error) {
    if (formatError(error) === "Нужна авторизация Mangabuff.") {
      await sendAuthRequiredNotification(settings).catch(() => {});
    }

    throw error;
  } finally {
    await closeBrowserSession(session);
  }
}

export async function runVisibleTradesLoop(
  db: AppDatabase,
  settings: BotSettings,
  options: TradesLoopOptions = {},
): Promise<void> {
  const settingsSource = options.getSettings ?? (() => settings);
  let passNumber = 0;
  let session: BrowserSession | undefined;
  const backgroundSchedule = createBackgroundPageSchedule();

  try {
    while (!options.signal?.aborted) {
      session ??= await openSavedMangabuffSession(resolveBotSettings(settingsSource));
      passNumber += 1;
      let result = await runTradesPassWithTimeout(db, session, settingsSource, passNumber);

      if (result.status === "ok") {
        try {
          await visitAwayPage(session.page, backgroundSchedule, options.signal);
        } catch (error) {
          if (error instanceof MangabuffInteractionBlockedError) {
            result = {
              status: "blocked",
              passNumber,
              reason: error.message,
              interruption: error.interruption,
            };
          } else {
            throw error;
          }
        }
      }

      if (result.status !== "auth_required") {
        await saveBrowserSessionState(session).catch(() => {});
      }
      options.onPass?.(result);

      const currentSettings = resolveBotSettings(settingsSource);

      if (result.status === "auth_required") {
        await sendAuthRequiredNotification(currentSettings);
        break;
      }

      if (result.status === "blocked") {
        if (result.interruption === "captcha") {
          logWarn("Mangabuff CAPTCHA detected; waiting in the current browser session", {
            passNumber,
            url: session.page.url(),
          });
          await sendCaptchaNotification(
            currentSettings,
            "detected",
            session.page.url(),
          ).catch((error) => {
            logWarn("Could not send Mangabuff CAPTCHA notification", {
              error: formatError(error),
              passNumber,
            });
          });

          const captchaCleared = await waitForMangabuffCaptchaToClear(session.page, {
            signal: options.signal,
          });

          if (captchaCleared) {
            logInfo("Mangabuff CAPTCHA cleared; continuing in the current browser session", {
              passNumber,
              url: session.page.url(),
            });
            await saveBrowserSessionState(session).catch(() => {});
            await sendCaptchaNotification(
              currentSettings,
              "cleared",
              session.page.url(),
            ).catch((error) => {
              logWarn("Could not send Mangabuff CAPTCHA cleared notification", {
                error: formatError(error),
                passNumber,
              });
            });
            continue;
          }
        }

        break;
      }

      if (result.status === "temporary_error" && shouldReopenBrowserSession(result.reason)) {
        await closeBrowserSession(session);
        session = undefined;
      }

      await waitForNextPass(currentSettings.loopPauseMs, options.signal);
    }
  } finally {
    await closeBrowserSession(session);
  }
}

function createBackgroundPageSchedule(now = Date.now()): BackgroundPageScheduleEntry[] {
  return backgroundPageIntervals.map((entry) => ({
    ...entry,
    nextVisitAt: now + randomizeBackgroundInterval(entry.intervalMs),
  }));
}

/**
 * The worker always leaves the offers index after a pass, so the pause between checks
 * is spent on an ordinary page instead of sitting on (and refreshing) `Предложения`.
 */
async function visitAwayPage(
  page: Page,
  schedule: BackgroundPageScheduleEntry[],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  const selectedIndex = selectBackgroundPageIndex(schedule);

  if (selectedIndex === undefined) {
    return;
  }

  const entry = schedule[selectedIndex];

  try {
    const response = await page.goto(entry.url, { waitUntil: "domcontentloaded" });
    const status = response?.status();
    await page.waitForTimeout(400);
    await assertMangabuffPageReady(page, status);

    if (status !== undefined && status >= 400) {
      throw new Error(`Mangabuff вернул HTTP ${status} для фоновой страницы.`);
    }

    await performIdlePageActivity(page, { signal });

    logInfo("Background Mangabuff page visited", {
      status,
      url: entry.url,
    });
  } catch (error) {
    if (error instanceof MangabuffInteractionBlockedError) {
      throw error;
    }

    logWarn("Background Mangabuff page visit failed", {
      error: formatError(error),
      url: entry.url,
    });
  } finally {
    entry.nextVisitAt = Date.now() + randomizeBackgroundInterval(entry.intervalMs);
  }
}

export function selectDueBackgroundPageIndex(
  schedule: readonly BackgroundPageScheduleEntry[],
  now = Date.now(),
  randomValue = Math.random(),
): number | undefined {
  const dueIndices = schedule.flatMap((entry, index) =>
    now >= entry.nextVisitAt ? [index] : [],
  );

  return pickRandomIndex(dueIndices, randomValue);
}

/**
 * Every pass needs a page to wait on. Due routes win; otherwise the closest one is
 * pulled forward, which keeps the short-interval routes as the usual idle place.
 */
export function selectBackgroundPageIndex(
  schedule: readonly BackgroundPageScheduleEntry[],
  now = Date.now(),
  randomValue = Math.random(),
): number | undefined {
  const dueIndex = selectDueBackgroundPageIndex(schedule, now, randomValue);

  if (dueIndex !== undefined) {
    return dueIndex;
  }

  if (schedule.length === 0) {
    return undefined;
  }

  const earliestVisitAt = Math.min(...schedule.map((entry) => entry.nextVisitAt));
  const earliestIndices = schedule.flatMap((entry, index) =>
    entry.nextVisitAt === earliestVisitAt ? [index] : [],
  );

  return pickRandomIndex(earliestIndices, randomValue);
}

function pickRandomIndex(indices: number[], randomValue: number): number | undefined {
  if (indices.length === 0) {
    return undefined;
  }

  const normalizedRandom = Math.min(1, Math.max(0, randomValue));
  const position = Math.min(indices.length - 1, Math.floor(normalizedRandom * indices.length));

  return indices[position];
}

function randomizeBackgroundInterval(intervalMs: number): number {
  return addSymmetricJitterMs(intervalMs, backgroundPageJitterFraction);
}

async function runTradesPass(
  db: AppDatabase,
  session: BrowserSession,
  settings: BotSettingsSource,
  passNumber: number,
): Promise<TradesPassResult> {
  try {
    const scanResult = await scanVisibleTradesInSession(db, session, settings);
    return { status: "ok", passNumber, ...scanResult };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (reason === "Нужна авторизация Mangabuff.") {
      return { status: "auth_required", passNumber, reason };
    }

    if (error instanceof MangabuffInteractionBlockedError) {
      return {
        status: "blocked",
        passNumber,
        reason,
        interruption: error.interruption,
      };
    }

    return { status: "temporary_error", passNumber, reason };
  }
}

async function runTradesPassWithTimeout(
  db: AppDatabase,
  session: BrowserSession,
  settings: BotSettingsSource,
  passNumber: number,
): Promise<TradesPassResult> {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutResult = new Promise<TradesPassResult>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        status: "temporary_error",
        passNumber,
        reason: `Браузерный проход проверки завис дольше ${tradePassTimeoutMs / 1_000} секунд.`,
      });
    }, tradePassTimeoutMs);
  });

  try {
    return await Promise.race([runTradesPass(db, session, settings, passNumber), timeoutResult]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function closeBrowserSession(session: BrowserSession | undefined): Promise<void> {
  await session?.browser.close().catch(() => {});
}

function shouldReopenBrowserSession(reason: string): boolean {
  return (
    reason.includes("Page crashed") ||
    reason.includes("Target page, context or browser has been closed") ||
    reason.includes("браузерная сессия перезапущена")
  );
}

export async function scanVisibleTradesInHttpSession(
  db: AppDatabase,
  session: MangabuffSessionClient,
  settings: BotSettingsSource,
): Promise<ScanTradesResult> {
  const { pageCount: visibleTradePageCount, visibleTrades } = await scanVisibleTradeLinksInHttpSession(session);
  const observations = observeVisibleTrades(db, visibleTrades);
  let insertedCount = 0;

  for (const observation of observations) {
    if (insertNewTrade(db, observation.trade.tradeId, observation.trade.tradeUrl)) {
      observation.isNew = true;
      insertedCount += 1;
    }
  }
  markVisibleTradesSeen(db, visibleTrades.map((trade) => trade.tradeId));

  const staleCount = markMissingTradesAsStale(
    db,
    visibleTrades.map((trade) => trade.tradeId),
  );
  const processingStats = {
    processedCount: 0,
    parsedCount: 0,
    manualReviewCount: 0,
    checkErrorCount: 0,
    pageStaleCount: 0,
    pagesCheckedCount: 0,
    rulesDroppedCount: 0,
    ranksCheckedCount: 0,
    safeAcceptCount: 0,
    acceptedCount: 0,
    skippedCount: 0,
  };
  const skippedStats = createSkippedTradeStats();
  const tradesToProcess = selectTradesForDetailCheck(db, observations, settings);
  const processableTradeIds = new Set(tradesToProcess.map((trade) => trade.tradeId));

  for (const trade of visibleTrades) {
    if (!processableTradeIds.has(trade.tradeId)) {
      processingStats.skippedCount += 1;
      recordSkippedTrade(skippedStats, findTradeById(db, trade.tradeId), trade.tradeId);
    }
  }

  for (const trade of tradesToProcess) {
    const tradeSettings = resolveBotSettings(settings);
    const result = await processVisibleTradeHttp(db, session, trade, tradeSettings);
    const notificationSettings = resolveBotSettings(settings);

    await sendProblemNotificationIfNeeded(db, notificationSettings, trade.tradeId);

    processingStats.processedCount += result.processed ? 1 : 0;
    processingStats.parsedCount += isParsedTradeOutcome(result.outcome) ? 1 : 0;
    processingStats.manualReviewCount += isManualReviewOutcome(result.outcome) ? 1 : 0;
    processingStats.checkErrorCount += result.outcome === "check_error" ? 1 : 0;
    processingStats.pageStaleCount += result.outcome === "stale" ? 1 : 0;
    processingStats.pagesCheckedCount += result.pagesChecked ? 1 : 0;
    processingStats.rulesDroppedCount += result.outcome === "rules_dropped" ? 1 : 0;
    processingStats.ranksCheckedCount += result.ranksChecked ? 1 : 0;
    processingStats.safeAcceptCount += result.outcome === "safe_accept" ? 1 : 0;
    processingStats.acceptedCount += result.outcome === "accepted" ? 1 : 0;

    if (result.outcome === "skipped") {
      processingStats.skippedCount += 1;
      recordSkippedTrade(skippedStats, findTradeById(db, trade.tradeId), trade.tradeId);
    }
  }

  return {
    visibleTrades,
    insertedCount,
    staleCount,
    ...processingStats,
    skippedStatusSummary: formatSkippedStatusSummary(skippedStats),
    skippedTradeIds: formatSkippedTradeIds(skippedStats),
    visibleTradePageCount,
  };
}

async function scanVisibleTradeLinksInHttpSession(
  session: MangabuffSessionClient,
): Promise<{ pageCount: number; visibleTrades: VisibleTrade[] }> {
  const firstPage = await session.getText(mangabuffTradesUrl);

  assertTradesPageReadable(firstPage);

  const pageCount = Math.min(readPaginationPagesCountFromHtml(firstPage.text) ?? 1, tradeListMaxPages);
  const tradesById = new Map<string, VisibleTrade>();

  addVisibleTradesFromHtml(tradesById, firstPage.text);

  for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
    const page = await session.getText(buildTradesPageUrl(pageNumber));

    assertTradesPageReadable(page);
    addVisibleTradesFromHtml(tradesById, page.text);
  }

  return {
    pageCount,
    visibleTrades: [...tradesById.values()],
  };
}

function assertTradesPageReadable(page: MangabuffTextResponse): void {
  if (page.status === 505 || htmlToText(page.text)?.includes("505")) {
    throw new Error("Mangabuff вернул ошибку 505 при загрузке вкладки предложений.");
  }

  if (!isMangabuffAuthorizedHttpResponse(page)) {
    throw new Error("Нужна авторизация Mangabuff.");
  }
}

function buildTradesPageUrl(pageNumber: number): string {
  const url = new URL(mangabuffTradesUrl);

  url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

export async function scanVisibleTradesInSession(
  db: AppDatabase,
  session: BrowserSession,
  settings: BotSettingsSource,
): Promise<ScanTradesResult> {
  await openTradesPage(session.page);

  if (!(await isMangabuffAuthorized(session.page))) {
    throw new Error("Нужна авторизация Mangabuff.");
  }

  await openOffersTab(session.page);
  const { fullyScanned, pageCount: visibleTradePageCount, visibleTrades } =
    await scanVisibleTradeLinksInBrowser(session.page);
  const observations = observeVisibleTrades(db, visibleTrades);
  let insertedCount = 0;

  for (const observation of observations) {
    if (insertNewTrade(db, observation.trade.tradeId, observation.trade.tradeUrl)) {
      observation.isNew = true;
      insertedCount += 1;
    }
  }
  markVisibleTradesSeen(db, visibleTrades.map((trade) => trade.tradeId));

  let staleCount = fullyScanned
    ? markMissingTradesAsStale(
        db,
        visibleTrades.map((trade) => trade.tradeId),
      )
    : 0;
  const processingStats = {
    processedCount: 0,
    parsedCount: 0,
    manualReviewCount: 0,
    checkErrorCount: 0,
    pageStaleCount: 0,
    pagesCheckedCount: 0,
    rulesDroppedCount: 0,
    ranksCheckedCount: 0,
    safeAcceptCount: 0,
    acceptedCount: 0,
    skippedCount: 0,
  };
  const skippedStats = createSkippedTradeStats();
  const tradesToProcess = selectTradesForDetailCheck(db, observations, settings);
  const processableTradeIds = new Set(tradesToProcess.map((trade) => trade.tradeId));

  for (const trade of visibleTrades) {
    if (!processableTradeIds.has(trade.tradeId)) {
      processingStats.skippedCount += 1;
      recordSkippedTrade(skippedStats, findTradeById(db, trade.tradeId), trade.tradeId);
    }
  }

  for (const [index, trade] of tradesToProcess.entries()) {
    const tradeSettings = resolveBotSettings(settings);
    const result = await processVisibleTrade(db, session.page, trade, tradeSettings);
    const notificationSettings = resolveBotSettings(settings);

    await sendProblemNotificationIfNeeded(db, notificationSettings, trade.tradeId);

    processingStats.processedCount += result.processed ? 1 : 0;
    processingStats.parsedCount += isParsedTradeOutcome(result.outcome) ? 1 : 0;
    processingStats.manualReviewCount += isManualReviewOutcome(result.outcome) ? 1 : 0;
    processingStats.checkErrorCount += result.outcome === "check_error" ? 1 : 0;
    processingStats.pageStaleCount += result.outcome === "stale" ? 1 : 0;
    processingStats.pagesCheckedCount += result.pagesChecked ? 1 : 0;
    processingStats.rulesDroppedCount += result.outcome === "rules_dropped" ? 1 : 0;
    processingStats.ranksCheckedCount += result.ranksChecked ? 1 : 0;
    processingStats.safeAcceptCount += result.outcome === "safe_accept" ? 1 : 0;
    processingStats.acceptedCount += result.outcome === "accepted" ? 1 : 0;

    if (result.outcome === "skipped") {
      processingStats.skippedCount += 1;
      recordSkippedTrade(skippedStats, findTradeById(db, trade.tradeId), trade.tradeId);
    }

    if (result.processed && index < tradesToProcess.length - 1) {
      await returnToOffersIndex(session.page);
      await waitBetweenTrades();
    }
  }

  if (processingStats.processedCount > 0) {
    staleCount += await refreshOffersIndexAfterProcessing(db, session.page);
  }

  return {
    visibleTrades,
    insertedCount,
    staleCount,
    ...processingStats,
    skippedStatusSummary: formatSkippedStatusSummary(skippedStats),
    skippedTradeIds: formatSkippedTradeIds(skippedStats),
    visibleTradePageCount,
  };
}

/**
 * The index is never reloaded while trades are being processed: the worker steps back
 * through history instead. One real reload happens after the last processed trade, so
 * finished offers disappear from the list and are recorded as stale right away.
 */
async function refreshOffersIndexAfterProcessing(db: AppDatabase, page: Page): Promise<number> {
  try {
    await openTradesPage(page);
    await openOffersTab(page);

    const { fullyScanned, visibleTrades } = await scanVisibleTradeLinksInBrowser(page);
    const visibleTradeIds = visibleTrades.map((trade) => trade.tradeId);

    markVisibleTradesSeen(db, visibleTradeIds);
    const staleCount = fullyScanned ? markMissingTradesAsStale(db, visibleTradeIds) : 0;

    logInfo("Offers index refreshed after processing", {
      staleCount,
      visibleCount: visibleTrades.length,
    });

    return staleCount;
  } catch (error) {
    if (error instanceof MangabuffInteractionBlockedError) {
      throw error;
    }

    // The pass results are already stored; a failed cleanup only delays it by one pass.
    logWarn("Could not refresh the offers index after processing", {
      error: formatError(error),
    });

    return 0;
  }
}

async function scanVisibleTradeLinksInBrowser(
  page: Page,
): Promise<{ fullyScanned: boolean; pageCount: number; visibleTrades: VisibleTrade[] }> {
  const availablePageCount = (await readPaginationPagesCount(page)) ?? 1;
  const pageCount = Math.min(availablePageCount, tradeListMaxPages);
  const tradesById = new Map<string, VisibleTrade>();

  addVisibleTrades(tradesById, await extractVisibleTradeLinks(page));

  for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
    await openTradeListPage(page, pageNumber);
    addVisibleTrades(tradesById, await extractVisibleTradeLinks(page));
  }

  if (pageCount > 1) {
    await returnToOffersIndex(page);
  }

  return {
    fullyScanned: availablePageCount <= tradeListMaxPages,
    pageCount,
    visibleTrades: [...tradesById.values()],
  };
}

function addVisibleTrades(target: Map<string, VisibleTrade>, trades: VisibleTrade[]): void {
  for (const trade of trades) {
    target.set(trade.tradeId, trade);
  }
}

async function openTradeListPage(page: Page, pageNumber: number): Promise<void> {
  const pagination = page.locator(".pagination, [class*='pagination'], nav[aria-label*='страниц' i]");
  const pageLink = pagination.locator(`a[href*="page=${pageNumber}"]`);

  if (await clickFirstVisible(pageLink)) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(400);
    await assertMangabuffPageReady(page);
    return;
  }

  // Fallback only when Mangabuff did not render a clickable pagination control.
  const response = await page.goto(buildTradesPageUrl(pageNumber), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await assertMangabuffPageReady(page, response?.status());
}

async function returnToOffersIndex(page: Page): Promise<void> {
  if (await goBackToOffersIndex(page)) {
    return;
  }

  const offersLink = page.locator('a[href="/trades"], a[href="https://mangabuff.ru/trades"]').filter({
    hasText: /предложения/i,
  });

  if (await clickFirstVisible(offersLink)) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(400);
    await assertMangabuffPageReady(page);
    return;
  }

  await openTradesPage(page);
}

/**
 * Browser history is the cheapest and most ordinary way back to `Предложения`: a
 * restored page usually costs no request at all, so returning between trades stops
 * re-fetching the index. Anything unexpected falls back to the visible tab link.
 */
export async function goBackToOffersIndex(page: Page): Promise<boolean> {
  return goBackUntil(page, isOffersIndexUrl, (currentPage) =>
    currentPage
      .locator('a[href^="/trades/"]')
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false),
  );
}

/**
 * The same back-button path from the requested card to the trade it belongs to.
 * A restored trade page can be stale, but the acceptance click is still verified
 * against a freshly loaded page afterwards.
 */
export async function goBackToTradePage(page: Page, tradeUrl: string): Promise<boolean> {
  const tradePath = readUrlPath(tradeUrl);

  if (!tradePath) {
    return false;
  }

  return goBackUntil(
    page,
    (url) => readUrlPath(url) === tradePath,
    (currentPage) =>
      currentPage
        .locator(".trade")
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false),
  );
}

async function goBackUntil(
  page: Page,
  isTargetUrl: (url: string) => boolean,
  verifyTargetPage: (page: Page) => Promise<boolean>,
): Promise<boolean> {
  for (let step = 0; step < maxHistoryBackSteps; step += 1) {
    const previousUrl = page.url();

    try {
      await page.goBack({ waitUntil: "domcontentloaded" });
    } catch {
      return false;
    }

    if (page.url() === previousUrl) {
      // Nothing left in this tab's history.
      return false;
    }

    if (!isTargetUrl(page.url())) {
      continue;
    }

    await page.waitForTimeout(400);
    await assertMangabuffPageReady(page);

    return await verifyTargetPage(page);
  }

  return false;
}

function isOffersIndexUrl(url: string): boolean {
  return readUrlPath(url) === "/trades";
}

function readUrlPath(url: string): string | undefined {
  try {
    return new URL(url, "https://mangabuff.ru").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return undefined;
  }
}

interface SkippedTradeStats {
  statuses: Partial<Record<TradeStatus | "missing", number>>;
  tradeIds: string[];
}

interface VisibleTradeObservation {
  isNew: boolean;
  previousRecord?: TradeRecord;
  trade: VisibleTrade;
}

function observeVisibleTrades(db: AppDatabase, visibleTrades: VisibleTrade[]): VisibleTradeObservation[] {
  return visibleTrades.map((trade) => ({
    isNew: false,
    previousRecord: findTradeById(db, trade.tradeId),
    trade,
  }));
}

function selectTradesForDetailCheck(
  db: AppDatabase,
  observations: VisibleTradeObservation[],
  settings: BotSettingsSource,
): VisibleTrade[] {
  const currentSettings = resolveBotSettings(settings);
  const eligible = observations.filter((observation) => {
    const record = findTradeById(db, observation.trade.tradeId);
    const reappeared = Boolean(observation.previousRecord?.missingAt);

    return shouldProcessTrade(record, currentSettings, true, observation.isNew || reappeared);
  });

  eligible.sort((left, right) => {
    const leftPriority = left.isNew ? 0 : left.previousRecord?.missingAt ? 1 : 2;
    const rightPriority = right.isNew ? 0 : right.previousRecord?.missingAt ? 1 : 2;
    return leftPriority - rightPriority;
  });

  const selected = maxTradeDetailsPerPass > 0 ? eligible.slice(0, maxTradeDetailsPerPass) : eligible;

  return selected.map((observation) => observation.trade);
}

function createSkippedTradeStats(): SkippedTradeStats {
  return {
    statuses: {},
    tradeIds: [],
  };
}

function recordSkippedTrade(stats: SkippedTradeStats, record: TradeRecord | undefined, tradeId: string): void {
  const status = record?.status ?? "missing";

  stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
  stats.tradeIds.push(tradeId);
}

function formatSkippedStatusSummary(stats: SkippedTradeStats): string | undefined {
  const entries = Object.entries(stats.statuses);

  if (entries.length === 0) {
    return undefined;
  }

  return entries.map(([status, count]) => `${status}:${count}`).join(",");
}

function formatSkippedTradeIds(stats: SkippedTradeStats): string | undefined {
  if (stats.tradeIds.length === 0) {
    return undefined;
  }

  return stats.tradeIds.join(",");
}

function resolveBotSettings(settings: BotSettingsSource): BotSettings {
  return typeof settings === "function" ? settings() : settings;
}

type ProcessTradeOutcome =
  | "parsed"
  | "manual_review"
  | "check_error"
  | "stale"
  | "pages_checked"
  | "rules_dropped"
  | "safe_accept"
  | "accepted"
  | "skipped";

function isParsedTradeOutcome(outcome: ProcessTradeOutcome): boolean {
  return (
    outcome === "parsed" ||
    outcome === "pages_checked" ||
    outcome === "rules_dropped" ||
    outcome === "safe_accept" ||
    outcome === "accepted"
  );
}

function isManualReviewOutcome(outcome: ProcessTradeOutcome): boolean {
  return outcome === "manual_review";
}

interface ProcessTradeResult {
  processed: boolean;
  outcome: ProcessTradeOutcome;
  pagesChecked?: boolean;
  ranksChecked?: boolean;
}

interface ParsedTradePage {
  senderName?: string;
  requestedCards: TradeCard[];
  offeredCards: TradeCard[];
}

async function processVisibleTradeHttp(
  db: AppDatabase,
  session: MangabuffSessionClient,
  trade: VisibleTrade,
  settings: BotSettings,
): Promise<ProcessTradeResult> {
  const record = findTradeById(db, trade.tradeId);

  if (!shouldProcessTrade(record, settings, true, true)) {
    return { processed: false, outcome: "skipped" };
  }

  recordTradeDetailCheck(db, trade.tradeId);

  try {
    if (record?.status === "принят" && record.acceptAttempts >= 2) {
      const reason = "Обмен снова появился во вкладке предложений после двух попыток принятия.";
      updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
      return { processed: true, outcome: "manual_review" };
    }

    const tradePage = await session.getText(trade.tradeUrl);
    const pageState = getTradePageStateFromHtml(tradePage);

    if (pageState === "not_found") {
      const status = recordTradeCheckFailure(
        db,
        trade.tradeId,
        "Страница обмена недоступна или показывает 404.",
      );
      return { processed: true, outcome: status === "ошибка_проверки" ? "check_error" : "manual_review" };
    }

    if (pageState === "cancelled") {
      updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен отменен на сайте.");
      return { processed: true, outcome: "stale" };
    }

    if (pageState === "accepted") {
      if ((record?.acceptAttempts ?? 0) > 0) {
        updateTradeStatus(db, trade.tradeId, "принят", "Сайт показывает, что обмен принят этим ботом.");
        return { processed: true, outcome: "accepted" };
      }

      updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен уже принят не этим ботом.");
      return { processed: true, outcome: "stale" };
    }

    const parsedTrade = parseActiveTradePageFromHtml(tradePage.text);
    validateParsedTrade(parsedTrade);

    if (parsedTrade.requestedCards.length > 1) {
      const reason = `В обмене хотят забрать больше одной карты: ${parsedTrade.requestedCards.length}.`;
      updateTradeParsedData(db, trade.tradeId, { ...parsedTrade, reason });
      updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
      return { processed: true, outcome: "manual_review" };
    }

    updateTradeParsedData(db, trade.tradeId, {
      ...parsedTrade,
      reason: "Состав обмена разобран.",
    });

    const requestedCard = parsedTrade.requestedCards[0];
    const wantedPagesCount = await countWantedPagesForRequestedCardHttp(session, requestedCard);

    if (!passesWantedPagesRule(wantedPagesCount, settings.maxWantedPagesExclusive)) {
      const ruleReason =
        `У запрошенной карты ${wantedPagesCount} страниц желающих. ` +
        `Правило требует меньше ${settings.maxWantedPagesExclusive}.`;
      const decision = getRuleFailureDecision(settings, ruleReason);

      updateTradeWantedPagesCount(db, trade.tradeId, wantedPagesCount, decision.reason);
      updateTradeStatus(db, trade.tradeId, decision.status, decision.reason);
      return { processed: true, outcome: decision.outcome, pagesChecked: true };
    }

    const rankedTrade = await recognizeTradeRanksHttp(session, parsedTrade);
    const requestedRank = rankedTrade.requestedCards[0].rank;
    const offeredRanks = rankedTrade.offeredCards.map((card) => card.rank);
    const recognizedOfferedRanks = offeredRanks.filter((rank): rank is CardRank => Boolean(rank));

    if (!requestedRank || recognizedOfferedRanks.length !== offeredRanks.length) {
      throw new Error("не удалось определить ранги всех карт обмена");
    }

    const rankSummary = formatRankSummary(requestedRank, recognizedOfferedRanks);

    updateTradeParsedData(db, trade.tradeId, {
      ...rankedTrade,
      reason: `Ранги карт распознаны: ${rankSummary}.`,
    });

    const supportedRequestedRank = isSupportedCardRank(requestedRank) ? requestedRank : undefined;
    const supportedOfferedRanks = recognizedOfferedRanks.filter(isSupportedCardRank);

    if (!supportedRequestedRank || supportedOfferedRanks.length !== recognizedOfferedRanks.length) {
      const reason = `В обмене есть неизвестный тип ранга: ${rankSummary}.`;

      updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
      return { processed: true, outcome: "manual_review", pagesChecked: true, ranksChecked: true };
    }

    if (!passesDefaultRankRule(supportedRequestedRank, supportedOfferedRanks)) {
      const ruleReason = `Ранговое правило не выполнено: ${rankSummary}.`;
      const decision = getRuleFailureDecision(settings, ruleReason);

      updateTradeRankRuleResult(db, trade.tradeId, "не_выполнено", ruleReason);
      updateTradeWantedPagesCount(db, trade.tradeId, wantedPagesCount, decision.reason);
      updateTradeStatus(db, trade.tradeId, decision.status, decision.reason);
      return { processed: true, outcome: decision.outcome, pagesChecked: true, ranksChecked: true };
    }

    const reason =
      `Бот бы принял обмен: у запрошенной карты ${wantedPagesCount} страниц желающих, ` +
      `ранговое правило выполнено (${rankSummary}).`;

    updateTradeRankRuleResult(db, trade.tradeId, "выполнено", reason);
    updateTradeWantedPagesCount(db, trade.tradeId, wantedPagesCount, reason);

    if (!settings.safeMode && settings.autoAcceptEnabled) {
      return await acceptTradeAfterRulesPassHttp(db, session, trade, record, reason);
    }

    updateTradeStatus(db, trade.tradeId, "бот_бы_принял", reason);

    return { processed: true, outcome: "safe_accept", pagesChecked: true, ranksChecked: true };
  } catch (error) {
    const status = recordTradeCheckFailure(
      db,
      trade.tradeId,
      `Не удалось разобрать страницу обмена: ${formatError(error)}`,
    );

    return { processed: true, outcome: status === "ошибка_проверки" ? "check_error" : "manual_review" };
  }
}

async function processVisibleTrade(
  db: AppDatabase,
  page: Page,
  trade: VisibleTrade,
  settings: BotSettings,
): Promise<ProcessTradeResult> {
  const record = findTradeById(db, trade.tradeId);

  if (!shouldProcessTrade(record, settings, true, true)) {
    return { processed: false, outcome: "skipped" };
  }

  recordTradeDetailCheck(db, trade.tradeId);

  try {
    if (record?.status === "принят" && record.acceptAttempts >= 2) {
      const reason = "Обмен снова появился во вкладке предложений после двух попыток принятия.";
      updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
      return { processed: true, outcome: "manual_review" };
    }

    await openTradeFromOffersIndex(page, trade);
    const pageState = await getTradePageState(page);

    if (pageState === "not_found") {
      const status = recordTradeCheckFailure(
        db,
        trade.tradeId,
        "Страница обмена недоступна или показывает 404.",
      );
      return { processed: true, outcome: status === "ошибка_проверки" ? "check_error" : "manual_review" };
    }

    if (pageState === "cancelled") {
      updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен отменен на сайте.");
      return { processed: true, outcome: "stale" };
    }

    if (pageState === "accepted") {
      if ((record?.acceptAttempts ?? 0) > 0) {
        updateTradeStatus(db, trade.tradeId, "принят", "Сайт показывает, что обмен принят этим ботом.");
        return { processed: true, outcome: "accepted" };
      }

      updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен уже принят не этим ботом.");
      return { processed: true, outcome: "stale" };
    }

    const parsedTrade = await parseActiveTradePage(page);
    validateParsedTrade(parsedTrade);

    if (parsedTrade.requestedCards.length > 1) {
      const reason = `В обмене хотят забрать больше одной карты: ${parsedTrade.requestedCards.length}.`;
      updateTradeParsedData(db, trade.tradeId, { ...parsedTrade, reason });
      updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
      return { processed: true, outcome: "manual_review" };
    }

    updateTradeParsedData(db, trade.tradeId, {
      ...parsedTrade,
      reason: "Состав обмена разобран.",
    });

    const requestedCard = parsedTrade.requestedCards[0];
    const wantedPagesCount = await countWantedPagesForRequestedCard(page, requestedCard);

    if (!passesWantedPagesRule(wantedPagesCount, settings.maxWantedPagesExclusive)) {
      const ruleReason =
        `У запрошенной карты ${wantedPagesCount} страниц желающих. ` +
        `Правило требует меньше ${settings.maxWantedPagesExclusive}.`;
      const decision = getRuleFailureDecision(settings, ruleReason);

      updateTradeWantedPagesCount(db, trade.tradeId, wantedPagesCount, decision.reason);
      updateTradeStatus(db, trade.tradeId, decision.status, decision.reason);
      return { processed: true, outcome: decision.outcome, pagesChecked: true };
    }

    const rankedTrade = await recognizeTradeRanks(page, parsedTrade);
    const requestedRank = rankedTrade.requestedCards[0].rank;
    const offeredRanks = rankedTrade.offeredCards.map((card) => card.rank);
    const recognizedOfferedRanks = offeredRanks.filter((rank): rank is CardRank => Boolean(rank));

    if (!requestedRank || recognizedOfferedRanks.length !== offeredRanks.length) {
      throw new Error("не удалось определить ранги всех карт обмена");
    }

    const rankSummary = formatRankSummary(requestedRank, recognizedOfferedRanks);

    updateTradeParsedData(db, trade.tradeId, {
      ...rankedTrade,
      reason: `Ранги карт распознаны: ${rankSummary}.`,
    });

    const supportedRequestedRank = isSupportedCardRank(requestedRank) ? requestedRank : undefined;
    const supportedOfferedRanks = recognizedOfferedRanks.filter(isSupportedCardRank);

    if (!supportedRequestedRank || supportedOfferedRanks.length !== recognizedOfferedRanks.length) {
      const reason = `В обмене есть неизвестный тип ранга: ${rankSummary}.`;

      updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
      return { processed: true, outcome: "manual_review", pagesChecked: true, ranksChecked: true };
    }

    if (!passesDefaultRankRule(supportedRequestedRank, supportedOfferedRanks)) {
      const ruleReason = `Ранговое правило не выполнено: ${rankSummary}.`;
      const decision = getRuleFailureDecision(settings, ruleReason);

      updateTradeRankRuleResult(db, trade.tradeId, "не_выполнено", ruleReason);
      updateTradeWantedPagesCount(db, trade.tradeId, wantedPagesCount, decision.reason);
      updateTradeStatus(db, trade.tradeId, decision.status, decision.reason);
      return { processed: true, outcome: decision.outcome, pagesChecked: true, ranksChecked: true };
    }

    const reason =
      `Бот бы принял обмен: у запрошенной карты ${wantedPagesCount} страниц желающих, ` +
      `ранговое правило выполнено (${rankSummary}).`;

    updateTradeRankRuleResult(db, trade.tradeId, "выполнено", reason);
    updateTradeWantedPagesCount(db, trade.tradeId, wantedPagesCount, reason);

    if (!settings.safeMode && settings.autoAcceptEnabled) {
      return await acceptTradeAfterRulesPass(db, page, trade, record, reason);
    }

    updateTradeStatus(db, trade.tradeId, "бот_бы_принял", reason);

    return { processed: true, outcome: "safe_accept", pagesChecked: true, ranksChecked: true };
  } catch (error) {
    if (error instanceof MangabuffInteractionBlockedError) {
      throw error;
    }

    const status = recordTradeCheckFailure(
      db,
      trade.tradeId,
      `Не удалось разобрать страницу обмена: ${formatError(error)}`,
    );

    return { processed: true, outcome: status === "ошибка_проверки" ? "check_error" : "manual_review" };
  }
}

async function acceptTradeAfterRulesPass(
  db: AppDatabase,
  page: Page,
  trade: VisibleTrade,
  record: TradeRecord | undefined,
  ruleReason: string,
): Promise<ProcessTradeResult> {
  if ((record?.acceptAttempts ?? 0) >= 2) {
    const reason = `Исчерпаны 2 попытки принятия. ${ruleReason}`;
    updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
    return { processed: true, outcome: "manual_review", pagesChecked: true, ranksChecked: true };
  }

  if (!(await goBackToTradePage(page, trade.tradeUrl))) {
    await openTradePage(page, trade.tradeUrl);
  }

  const pageState = await getTradePageState(page);

  if (pageState === "not_found") {
    const status = recordTradeCheckFailure(
      db,
      trade.tradeId,
      "Страница обмена недоступна перед принятием.",
    );
    return {
      processed: true,
      outcome: status === "ошибка_проверки" ? "check_error" : "manual_review",
      pagesChecked: true,
      ranksChecked: true,
    };
  }

  if (pageState === "cancelled") {
    updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен отменен на сайте перед принятием.");
    return { processed: true, outcome: "stale", pagesChecked: true, ranksChecked: true };
  }

  if (pageState === "accepted") {
    updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен уже принят до клика этого бота.");
    return { processed: true, outcome: "stale", pagesChecked: true, ranksChecked: true };
  }

  const acceptButton = page.locator("button, a").filter({ hasText: /^\s*Принять обмен\s*$/ }).first();

  if (!(await acceptButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
    throw new Error('не удалось найти кнопку "Принять обмен"');
  }

  recordTradeAcceptAttempt(db, trade.tradeId);
  await assertMangabuffPageReady(page);
  await clickVerified(acceptButton, 'кнопка "Принять обмен"');
  const confirmationClicked = await confirmAcceptIfNeeded(page);

  if (!confirmationClicked) {
    const status = recordTradeCheckFailure(
      db,
      trade.tradeId,
      "Бот нажал принятие, но не увидел модальное подтверждение действия.",
    );
    return {
      processed: true,
      outcome: status === "ошибка_проверки" ? "check_error" : "manual_review",
      pagesChecked: true,
      ranksChecked: true,
    };
  }

  if (await waitForAcceptedTradeState(page, trade.tradeUrl)) {
    const reason = ruleReason.replace("Бот бы принял обмен", "Бот принял обмен");
    updateTradeStatus(db, trade.tradeId, "принят", reason);
    return { processed: true, outcome: "accepted", pagesChecked: true, ranksChecked: true };
  }

  const status = recordTradeCheckFailure(
    db,
    trade.tradeId,
    "Бот нажал принятие, но сайт не показал статус `Обмен принят`.",
  );

  return {
    processed: true,
    outcome: status === "ошибка_проверки" ? "check_error" : "manual_review",
    pagesChecked: true,
    ranksChecked: true,
  };
}

async function acceptTradeAfterRulesPassHttp(
  db: AppDatabase,
  session: MangabuffSessionClient,
  trade: VisibleTrade,
  record: TradeRecord | undefined,
  ruleReason: string,
): Promise<ProcessTradeResult> {
  if ((record?.acceptAttempts ?? 0) >= 2) {
    const reason = `Исчерпаны 2 попытки принятия. ${ruleReason}`;
    updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
    return { processed: true, outcome: "manual_review", pagesChecked: true, ranksChecked: true };
  }

  const tradePage = await session.getText(trade.tradeUrl);
  const pageState = getTradePageStateFromHtml(tradePage);

  if (pageState === "not_found") {
    const status = recordTradeCheckFailure(
      db,
      trade.tradeId,
      "Страница обмена недоступна перед принятием.",
    );
    return {
      processed: true,
      outcome: status === "ошибка_проверки" ? "check_error" : "manual_review",
      pagesChecked: true,
      ranksChecked: true,
    };
  }

  if (pageState === "cancelled") {
    updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен отменен на сайте перед принятием.");
    return { processed: true, outcome: "stale", pagesChecked: true, ranksChecked: true };
  }

  if (pageState === "accepted") {
    updateTradeStatus(db, trade.tradeId, "неактуален", "Обмен уже принят до HTTP-принятия этого бота.");
    return { processed: true, outcome: "stale", pagesChecked: true, ranksChecked: true };
  }

  if (!hasAcceptTradeButton(tradePage.text)) {
    throw new Error('не удалось найти кнопку "Принять обмен"');
  }

  const csrfToken = readCsrfTokenFromHtml(tradePage.text);

  if (!csrfToken) {
    throw new Error("не удалось найти CSRF-токен для принятия обмена");
  }

  recordTradeAcceptAttempt(db, trade.tradeId);

  const acceptResponse = await session.postForm(
    `https://mangabuff.ru/trades/${trade.tradeId}/accept`,
    {},
    {
      csrfToken,
      referer: tradePage.url,
    },
  );

  if (!acceptResponse.ok) {
    throw new Error(`сайт отклонил HTTP-принятие обмена: ${formatHttpJsonError(acceptResponse.status, acceptResponse.json)}`);
  }

  if (await waitForAcceptedTradeStateHttp(session, trade.tradeUrl)) {
    const reason = ruleReason.replace("Бот бы принял обмен", "Бот принял обмен");
    updateTradeStatus(db, trade.tradeId, "принят", reason);
    return { processed: true, outcome: "accepted", pagesChecked: true, ranksChecked: true };
  }

  const status = recordTradeCheckFailure(
    db,
    trade.tradeId,
    "Бот отправил HTTP-принятие, но сайт не показал статус `Обмен принят`.",
  );

  return {
    processed: true,
    outcome: status === "ошибка_проверки" ? "check_error" : "manual_review",
    pagesChecked: true,
    ranksChecked: true,
  };
}

async function confirmAcceptIfNeeded(page: Page): Promise<boolean> {
  const confirmButton = page
    .locator('[role="dialog"] button, .modal button, [class*="modal"] button, [class*="Modal"] button')
    .filter({ hasText: /^\s*Принять\s*$/ })
    .last();

  if (!(await confirmButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return false;
  }

  await assertMangabuffPageReady(page);
  await clickVerified(confirmButton, 'подтверждение "Принять"');
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

async function waitForAcceptedTradeState(page: Page, tradeUrl: string): Promise<boolean> {
  if (await hasAcceptedTradeText(page)) {
    return true;
  }

  await openTradePage(page, tradeUrl);
  return hasAcceptedTradeText(page);
}

async function waitForAcceptedTradeStateHttp(
  session: MangabuffSessionClient,
  tradeUrl: string,
): Promise<boolean> {
  const tradePage = await session.getText(tradeUrl);
  return getTradePageStateFromHtml(tradePage) === "accepted";
}

async function hasAcceptedTradeText(page: Page): Promise<boolean> {
  const bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
  return bodyText.includes("Обмен принят");
}

function getRuleFailureDecision(
  settings: BotSettings,
  ruleReason: string,
): {
  status: "требует_ручной_проверки" | "брошен_по_правилам";
  outcome: "manual_review" | "rules_dropped";
  reason: string;
} {
  if (settings.safeMode) {
    return {
      status: "требует_ручной_проверки",
      outcome: "manual_review",
      reason: ruleReason,
    };
  }

  return {
    status: "брошен_по_правилам",
    outcome: "rules_dropped",
    reason: ruleReason,
  };
}

async function recognizeTradeRanks(page: Page, parsedTrade: ParsedTradePage): Promise<ParsedTradePage> {
  return {
    senderName: parsedTrade.senderName,
    requestedCards: await recognizeCardsRanks(page, parsedTrade.requestedCards),
    offeredCards: await recognizeCardsRanks(page, parsedTrade.offeredCards),
  };
}

async function recognizeTradeRanksHttp(
  session: MangabuffSessionClient,
  parsedTrade: ParsedTradePage,
): Promise<ParsedTradePage> {
  return {
    senderName: parsedTrade.senderName,
    requestedCards: await recognizeCardsRanksHttp(session, parsedTrade.requestedCards),
    offeredCards: await recognizeCardsRanksHttp(session, parsedTrade.offeredCards),
  };
}

async function recognizeCardsRanks(page: Page, cards: TradeCard[]): Promise<TradeCard[]> {
  const rankedCards: TradeCard[] = [];

  for (const card of cards) {
    const recognition = card.imageUrl
      ? await recognizeCardRankFromImage(page, card.imageUrl)
      : await recognizeCardPageRank(page, card.url);
    rankedCards.push({ ...card, rank: recognition.rank });
  }

  return rankedCards;
}

async function recognizeCardsRanksHttp(
  session: MangabuffSessionClient,
  cards: TradeCard[],
): Promise<TradeCard[]> {
  const rankedCards: TradeCard[] = [];

  for (const card of cards) {
    const imageUrl = card.imageUrl ?? (await findCardImageUrlHttp(session, card.url));
    const response = await session.getBytes(imageUrl);

    if (!response.ok) {
      throw new Error(`не удалось загрузить изображение карты ${card.cardId}: HTTP ${response.status}`);
    }

    const recognition = await recognizeCardRankFromImageBytes(response.bytes);
    rankedCards.push({ ...card, imageUrl, rank: recognition.rank });
  }

  return rankedCards;
}

async function findCardImageUrlHttp(session: MangabuffSessionClient, cardUrl: string): Promise<string> {
  const response = await session.getText(cardUrl);

  if (!response.ok) {
    throw new Error(`не удалось открыть страницу карты ${cardUrl}: HTTP ${response.status}`);
  }

  const imageUrl = findFirstCardImageUrl(response.text);

  if (!imageUrl) {
    throw new Error(`Не удалось найти изображение карты на странице ${cardUrl}.`);
  }

  return imageUrl;
}

function formatRankSummary(requestedRank: CardRank, offeredRanks: CardRank[]): string {
  return `запрошена ${requestedRank}, предлагают ${offeredRanks.join(", ")}`;
}

function shouldProcessTrade(
  record: TradeRecord | undefined,
  settings: BotSettings,
  canAcceptTrades: boolean,
  ignoreDetailCooldown = false,
): boolean {
  if (!record) {
    return true;
  }

  let processable = shouldRecheckLegacyWantedPagesRecord(record);

  if (record.status === "бот_бы_принял") {
    processable ||= canAcceptTrades && !settings.safeMode && settings.autoAcceptEnabled;
  }

  if (record.status === "принят" || record.status === "неактуален" || record.status === "ошибка_проверки") {
    processable = true;
  } else if (isFinalTradeStatus(record.status) && !processable) {
    return false;
  } else if (record.status === "новое") {
    processable = true;
  }

  if (!processable) {
    return false;
  }

  return ignoreDetailCooldown || hasTradeDetailCooldownElapsed(record);
}

function hasTradeDetailCooldownElapsed(record: TradeRecord, now = Date.now()): boolean {
  if (!record.lastDetailCheckedAt) {
    return true;
  }

  const checkedAt = Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(record.lastDetailCheckedAt)
      ? record.lastDetailCheckedAt
      : `${record.lastDetailCheckedAt.replace(" ", "T")}Z`,
  );

  return !Number.isFinite(checkedAt) || now - checkedAt >= unchangedTradeDetailCooldownMs;
}

function shouldRecheckLegacyWantedPagesRecord(record: TradeRecord): boolean {
  if (!["бот_бы_принял", "брошен_по_правилам", "требует_ручной_проверки"].includes(record.status)) {
    return false;
  }

  return [...record.requestedCards, ...record.offeredCards].some((card) => /\/cards\/[^/?#]+\/users(?:[?#]|$)/.test(card.url));
}

async function sendProblemNotificationIfNeeded(
  db: AppDatabase,
  settings: BotSettings,
  tradeId: string,
): Promise<void> {
  const record = findTradeById(db, tradeId);

  if (!record || record.telegramSent || !isProblemStatusForTelegram(record.status)) {
    return;
  }

  await sendTradeProblemNotification(settings, record);
  markTradeTelegramSent(db, tradeId);
}

function isProblemStatusForTelegram(status: TradeRecord["status"]): boolean {
  return status === "требует_ручной_проверки" || status === "брошен_по_правилам";
}

async function countWantedPagesForRequestedCard(page: Page, requestedCard: TradeCard): Promise<number> {
  await openRequestedCardFromTrade(page, requestedCard);
  await openWantedUsersSection(page);
  return countWantedUsersPages(page);
}

async function countWantedPagesForRequestedCardHttp(
  session: MangabuffSessionClient,
  requestedCard: TradeCard,
): Promise<number> {
  const wantedUsersUrl = buildWantedOffersUrl(requestedCard.cardId);

  try {
    const response = await session.getText(wantedUsersUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return countWantedUsersPagesFromHtml(response.text);
  } catch (error) {
    throw new Error(`не удалось открыть страницу запрошенной карты ${requestedCard.cardId}: ${formatError(error)}`);
  }
}

function readPaginationPagesCountFromHtml(html: string): number | undefined {
  const pageNumbers = [...html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gis)]
    .map((match) => readPageNumberFromHref(match[2]))
    .filter((pageNumber): pageNumber is number => pageNumber !== undefined);

  if (pageNumbers.length === 0) {
    return undefined;
  }

  return Math.max(...pageNumbers);
}

function readPageNumberFromHref(href: string): number | undefined {
  const decodedHref = decodeHtmlAttributeValue(href);

  try {
    const url = new URL(decodedHref, "https://mangabuff.ru");
    const pageNumber = Number(url.searchParams.get("page"));

    if (Number.isInteger(pageNumber) && pageNumber > 0) {
      return pageNumber;
    }
  } catch {
    const pageMatch = decodedHref.match(/[?&]page=(\d+)/);
    const pageNumber = pageMatch ? Number(pageMatch[1]) : NaN;

    if (Number.isInteger(pageNumber) && pageNumber > 0) {
      return pageNumber;
    }
  }

  return undefined;
}

function decodeHtmlAttributeValue(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
}

function htmlToText(html: string): string {
  return normalizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )?.toLowerCase() ?? "";
}

async function openRequestedCardPage(page: Page, requestedCard: TradeCard): Promise<void> {
  try {
    const response = await page.goto(`https://mangabuff.ru/cards/${requestedCard.cardId}/users`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);
    await assertMangabuffPageReady(page, response?.status());
  } catch (error) {
    if (error instanceof MangabuffInteractionBlockedError) {
      throw error;
    }

    throw new Error(`не удалось открыть страницу запрошенной карты ${requestedCard.cardId}: ${formatError(error)}`);
  }
}

async function openRequestedCardFromTrade(page: Page, requestedCard: TradeCard): Promise<void> {
  const requestedCardLink = page.locator(
    `.trade__main-items--receiver a[href*="/cards/${requestedCard.cardId}/"]`,
  );

  if (await clickFirstVisible(requestedCardLink)) {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);
    await assertMangabuffPageReady(page);
    return;
  }

  await openRequestedCardPage(page, requestedCard);
}

async function openWantedUsersSection(page: Page): Promise<void> {
  const wantedUsersTab = page.getByText("Хотят получить", { exact: true }).first();

  if (!(await wantedUsersTab.isVisible({ timeout: 5_000 }).catch(() => false))) {
    throw new Error('не удалось найти раздел "Хотят получить" на странице карты');
  }

  await clickVerified(wantedUsersTab, 'вкладка "Хотят получить"');
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(500);
  await assertMangabuffPageReady(page);
}

async function countWantedUsersPages(page: Page): Promise<number> {
  const paginationPagesCount = await readPaginationPagesCount(page);

  if (paginationPagesCount !== undefined) {
    return paginationPagesCount;
  }

  if (await hasEmptyWantedUsersState(page)) {
    return 0;
  }

  if (await hasVisibleWantedUsers(page)) {
    return 1;
  }

  return 0;
}

async function hasEmptyWantedUsersState(page: Page): Promise<boolean> {
  const bodyText = normalizeText(await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""));

  if (!bodyText) {
    return false;
  }

  return [
    "никто не хочет получить",
    "нет желающих",
    "нет пользователей",
    "пользователей не найдено",
    "список пуст",
  ].some((emptyText) => bodyText.toLowerCase().includes(emptyText));
}

async function readPaginationPagesCount(page: Page): Promise<number | undefined> {
  const paginationLocator = page.locator(
    [
      ".pagination",
      "[class*='pagination']",
      "[class*='Pagination']",
      "nav[aria-label*='pagination' i]",
      "nav[aria-label*='страниц' i]",
    ].join(", "),
  );

  const pages = await paginationLocator.evaluateAll((elements) => {
    const pageNumbers: number[] = [];

    for (const element of elements) {
      const rect = element.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      for (const textPart of (element.textContent ?? "").matchAll(/\b\d+\b/g)) {
        const pageNumber = Number(textPart[0]);

        if (Number.isInteger(pageNumber) && pageNumber > 0) {
          pageNumbers.push(pageNumber);
        }
      }
    }

    return pageNumbers;
  });

  if (pages.length === 0) {
    return undefined;
  }

  return Math.max(...pages);
}

async function hasVisibleWantedUsers(page: Page): Promise<boolean> {
  const userLinksCount = await page.locator(
    [
      'main a[href*="/users/"]',
      '.content a[href*="/users/"]',
      '.page__content a[href*="/users/"]',
      '.users-list a[href*="/users/"]',
      '.users a[href*="/users/"]',
    ].join(", "),
  ).evaluateAll((links) => {
    const visibleUserHrefs = new Set<string>();

    for (const link of links) {
      const rect = link.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) {
        continue;
      }

      if (link.closest("header, nav, footer")) {
        continue;
      }

      visibleUserHrefs.add((link as HTMLAnchorElement).href);
    }

    return visibleUserHrefs.size;
  });

  return userLinksCount > 0;
}

function getTradePageStateFromHtml(
  response: MangabuffTextResponse,
): "active" | "cancelled" | "accepted" | "not_found" {
  const bodyText = htmlFragmentToText(response.text);

  if (
    response.status === 404 ||
    bodyText.includes("Страница не найдена") ||
    /\/404(?:$|[/?#])/.test(response.url)
  ) {
    return "not_found";
  }

  if (bodyText.includes("Обмен отменен")) {
    return "cancelled";
  }

  if (bodyText.includes("Обмен принят")) {
    return "accepted";
  }

  return "active";
}

function parseActiveTradePageFromHtml(html: string): ParsedTradePage {
  const trade = findElementByClass(html, "trade");

  if (!trade) {
    throw new Error("не удалось найти блок обмена на странице");
  }

  return {
    senderName: readSenderNameFromHtml(trade.html),
    offeredCards: readCardsFromHtml(findElementByClass(trade.html, "trade__main-items--creator")?.html ?? ""),
    requestedCards: readCardsFromHtml(findElementByClass(trade.html, "trade__main-items--receiver")?.html ?? ""),
  };
}

function readSenderNameFromHtml(tradeHtml: string): string | undefined {
  const header = findElementByClass(tradeHtml, "trade__header")?.html;

  if (!header) {
    return undefined;
  }

  const nameLink = findElementByClass(header, "trade__header-name")?.html;
  const linkText = normalizeText(htmlFragmentToText(nameLink));

  if (linkText) {
    return linkText;
  }

  return normalizeText(htmlFragmentToText(header).split("предлагает обмен")[0]);
}

function hasAcceptTradeButton(html: string): boolean {
  return /<button\b[^>]*class=["'][^"']*\btrade__accepted-btn\b[^"']*["'][^>]*>/i.test(html);
}

function readCsrfTokenFromHtml(html: string): string | undefined {
  for (const metaTag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (readHtmlAttribute(metaTag, "name") === "csrf-token") {
      return readHtmlAttribute(metaTag, "content");
    }
  }

  return undefined;
}

function readCardsFromHtml(sectionHtml: string): TradeCard[] {
  const cards: TradeCard[] = [];

  for (const linkHtml of sectionHtml.match(/<a\b[\s\S]*?<\/a>/gi) ?? []) {
    const href = readHtmlAttribute(linkHtml, "href");

    if (!href || !/\/cards\/[^/?#]+/.test(href)) {
      continue;
    }

    const url = new URL(href, "https://mangabuff.ru").href;
    const cardId = url.match(/\/cards\/([^/?#]+)/)?.[1] ?? "";
    const imageTag = linkHtml.match(/<img\b[^>]*>/i)?.[0];
    const imageSrc = imageTag ? readHtmlAttribute(imageTag, "src") : undefined;
    const imageTitle = normalizeCardTitle(imageTag ? readHtmlAttribute(imageTag, "alt") : undefined);
    const linkTitle = normalizeText(htmlFragmentToText(linkHtml));

    cards.push({
      cardId,
      url: cardId ? buildWantedOffersUrl(cardId) : url,
      imageUrl: imageSrc ? new URL(imageSrc, "https://mangabuff.ru").href : undefined,
      title: imageTitle ?? linkTitle,
    });
  }

  return cards;
}

function findFirstCardImageUrl(html: string): string | undefined {
  for (const imageTag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = readHtmlAttribute(imageTag, "src");

    if (src?.includes("/img/cards/")) {
      return new URL(src, "https://mangabuff.ru").href;
    }
  }

  return undefined;
}

async function openTradePage(page: Page, tradeUrl: string): Promise<void> {
  try {
    const response = await page.goto(tradeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);
    await assertMangabuffPageReady(page, response?.status());
  } catch (error) {
    if (error instanceof MangabuffInteractionBlockedError) {
      throw error;
    }

    throw new Error(`Не удалось открыть страницу обмена: ${formatError(error)}`);
  }
}

async function openTradeFromOffersIndex(page: Page, trade: VisibleTrade): Promise<void> {
  const currentUrl = new URL(page.url());

  if (currentUrl.pathname === "/trades") {
    const tradeLink = page.locator(`a[href="/trades/${trade.tradeId}"]`);

    if (await clickFirstVisible(tradeLink)) {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(500);
      await assertMangabuffPageReady(page);
      return;
    }
  }

  await openTradePage(page, trade.tradeUrl);
}

async function getTradePageState(page: Page): Promise<"active" | "cancelled" | "accepted" | "not_found"> {
  const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");

  if (bodyText.includes("Страница не найдена") || /\/404(?:$|[/?#])/.test(page.url())) {
    return "not_found";
  }

  if (bodyText.includes("Обмен отменен")) {
    return "cancelled";
  }

  if (bodyText.includes("Обмен принят")) {
    return "accepted";
  }

  return "active";
}

async function parseActiveTradePage(page: Page): Promise<ParsedTradePage> {
  const trade = page.locator(".trade").first();
  await trade.waitFor({ state: "attached", timeout: 3_000 });

  return {
    senderName: await readSenderName(trade),
    offeredCards: await readCards(trade.locator('.trade__main-items--creator a[href*="/cards/"]')),
    requestedCards: await readCards(trade.locator('.trade__main-items--receiver a[href*="/cards/"]')),
  };
}

async function readSenderName(trade: Locator): Promise<string | undefined> {
  const userLinks = trade.locator('.trade__header a[href*="/users/"]');
  const linksCount = await userLinks.count();

  for (let index = 0; index < linksCount; index += 1) {
    const text = normalizeText(await userLinks.nth(index).innerText().catch(() => ""));

    if (text) {
      return text;
    }
  }

  const headerText = normalizeText(await trade.locator(".trade__header").innerText().catch(() => ""));
  return normalizeText(headerText?.split("предлагает обмен")[0]);
}

async function readCards(cardLinks: Locator): Promise<TradeCard[]> {
  const cards: TradeCard[] = [];
  const linksCount = await cardLinks.count();

  for (let index = 0; index < linksCount; index += 1) {
    const cardLink = cardLinks.nth(index);
    const href = await cardLink.getAttribute("href");
    const url = href ? new URL(href, "https://mangabuff.ru").href : "";
    const cardId = url.match(/\/cards\/([^/?#]+)/)?.[1] ?? "";
    const imageSrc = await cardLink.locator("img").first().getAttribute("src").catch(() => null);
    const imageTitle = normalizeText(await cardLink.locator("img").first().getAttribute("alt").catch(() => null));
    const linkTitle = normalizeText(await cardLink.innerText().catch(() => ""));

    cards.push({
      cardId,
      url: cardId ? buildWantedOffersUrl(cardId) : url,
      imageUrl: imageSrc ? new URL(imageSrc, "https://mangabuff.ru").href : undefined,
      title: imageTitle ?? linkTitle,
    });
  }

  return cards;
}

function normalizeText(value: string | null | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

function validateParsedTrade(parsedTrade: ParsedTradePage): void {
  if (!parsedTrade.senderName) {
    throw new Error("не удалось определить пользователя, который предложил обмен");
  }

  if (parsedTrade.requestedCards.length === 0) {
    throw new Error("не удалось определить карты, которые хотят забрать");
  }

  if (parsedTrade.offeredCards.length === 0) {
    throw new Error("не удалось определить карты, которые предлагают взамен");
  }

  if (parsedTrade.requestedCards.some((card) => !card.cardId)) {
    throw new Error("не удалось определить ID одной из запрошенных карт");
  }

  if (parsedTrade.offeredCards.some((card) => !card.cardId)) {
    throw new Error("не удалось определить ID одной из предложенных карт");
  }
}

async function openTradesPage(page: Page): Promise<void> {
  try {
    const response = await page.goto(mangabuffTradesUrl, { waitUntil: "domcontentloaded" });
    await assertMangabuffPageReady(page, response?.status());
  } catch (error) {
    if (error instanceof MangabuffInteractionBlockedError) {
      throw error;
    }

    throw new Error(`Не удалось загрузить вкладку предложений: ${formatError(error)}`);
  }

  const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");

  if (bodyText.includes("505")) {
    throw new Error("Mangabuff вернул ошибку 505 при загрузке вкладки предложений.");
  }
}

async function openOffersTab(page: Page): Promise<void> {
  if (new URL(page.url()).pathname === "/trades") {
    return;
  }

  const offersTabs = page.locator('a[href="/trades"], a[href="https://mangabuff.ru/trades"]').filter({
    hasText: /предложения/i,
  });
  const clicked = await clickFirstVisible(offersTabs);

  if (!clicked) {
    throw new Error('Не удалось найти вкладку "Предложения" в разделе обменов.');
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(500);
  await assertMangabuffPageReady(page);
}

async function clickFirstVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);

    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    await candidate
      .evaluate((element) => {
        if (element instanceof HTMLAnchorElement) {
          element.target = "_self";
        }
      })
      .catch(() => {});
    await clickVerified(candidate, "переход по видимой ссылке", {
      noWaitAfter: true,
      timeout: 3_000,
    });
    return true;
  }

  return false;
}

function extractVisibleTradeLinksFromHtml(html: string): VisibleTrade[] {
  const tradesById = new Map<string, VisibleTrade>();

  addVisibleTradesFromHtml(tradesById, html);
  return [...tradesById.values()];
}

function addVisibleTradesFromHtml(tradesById: Map<string, VisibleTrade>, html: string): void {
  const visibleHtml = removeClearlyHiddenHtml(html);

  for (const match of visibleHtml.matchAll(/href=["']([^"']*\/trades\/(\d+)[^"']*)["']/gi)) {
    const tradeId = match[2];

    tradesById.set(tradeId, {
      tradeId,
      tradeUrl: `https://mangabuff.ru/trades/${tradeId}`,
    });
  }
}

function removeClearlyHiddenHtml(html: string): string {
  let visibleHtml = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ");

  let previousHtml: string;

  do {
    previousHtml = visibleHtml;
    visibleHtml = visibleHtml.replace(
      /<([a-z][\w:-]*)\b(?=[^>]*(?:\bhidden\b|\baria-hidden\s*=\s*["']?true|\bstyle\s*=\s*["'][^"']*display\s*:\s*none|\bclass\s*=\s*["'][^"']*(?:\bd-none\b|\bhidden\b|\bis-hidden\b|\btab-pane\b(?![^"']*\bactive\b))))[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );
  } while (visibleHtml !== previousHtml);

  return visibleHtml;
}

async function extractVisibleTradeLinks(page: Page): Promise<VisibleTrade[]> {
  const hrefs = await page.locator("a[href^='/trades/'], a[href*='mangabuff.ru/trades/']").evaluateAll(
    (links) =>
      links
        .filter((link) => {
          const rect = link.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((link) => (link as HTMLAnchorElement).href),
  );

  const tradesById = new Map<string, VisibleTrade>();

  for (const href of hrefs) {
    const tradeId = href.match(/\/trades\/([^/?#]+)/)?.[1];

    if (tradeId && /^\d+$/.test(tradeId)) {
      tradesById.set(tradeId, {
        tradeId,
        tradeUrl: `https://mangabuff.ru/trades/${tradeId}`,
      });
    }
  }

  return [...tradesById.values()];
}

interface HtmlElementMatch {
  html: string;
  start: number;
  end: number;
}

function findElementByClass(html: string, className: string): HtmlElementMatch | undefined {
  const openTagPattern = /<([a-z][\w-]*)\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = openTagPattern.exec(html))) {
    const classAttribute = readHtmlAttribute(match[0], "class");

    if (!classAttribute?.split(/\s+/).includes(className)) {
      continue;
    }

    return readElementAt(html, match.index, match[1]);
  }

  return undefined;
}

function readElementAt(html: string, start: number, tagName: string): HtmlElementMatch {
  const tagPattern = new RegExp(`</?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html))) {
    const tag = match[0];
    const isClosingTag = tag.startsWith("</");
    const isSelfClosingTag = tag.endsWith("/>");

    if (isClosingTag) {
      depth -= 1;
    } else if (!isSelfClosingTag) {
      depth += 1;
    }

    if (depth === 0) {
      return {
        html: html.slice(start, tagPattern.lastIndex),
        start,
        end: tagPattern.lastIndex,
      };
    }
  }

  return {
    html: html.slice(start),
    start,
    end: html.length,
  };
}

function readHtmlAttribute(tagHtml: string, name: string): string | undefined {
  const match = tagHtml.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*([\"'])([\\s\\S]*?)\\1`, "i"));
  return match ? decodeHtmlEntities(match[2]) : undefined;
}

function htmlFragmentToText(html: string | undefined): string {
  if (!html) {
    return "";
  }

  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function normalizeCardTitle(value: string | undefined): string | undefined {
  const title = normalizeText(value);
  return title && title !== "Карточка" ? title : undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForNextPass(loopPauseMs: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(addPositiveJitterMs(loopPauseMs, offersPauseJitterFraction), undefined, { signal });
  } catch (error) {
    if (!signal?.aborted) {
      throw error;
    }
  }
}

async function waitBetweenTrades(): Promise<void> {
  await sleep(randomTradePauseMs());
}

function randomTradePauseMs(): number {
  const minMs = Math.min(tradePauseMinMs, tradePauseMaxMs);
  const maxMs = Math.max(tradePauseMinMs, tradePauseMaxMs);

  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatHttpJsonError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const source = body as Record<string, unknown>;

    if (typeof source.message === "string") {
      return `HTTP ${status}: ${source.message}`;
    }

    if (source.errors && typeof source.errors === "object") {
      const firstError = Object.values(source.errors as Record<string, unknown>)[0];

      if (Array.isArray(firstError) && typeof firstError[0] === "string") {
        return `HTTP ${status}: ${firstError[0]}`;
      }
    }
  }

  return `HTTP ${status}`;
}

function readIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }

  return value;
}

function readFloatEnv(name: string, fallback: number, min: number, max: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value < min || value > max) {
    return fallback;
  }

  return value;
}
