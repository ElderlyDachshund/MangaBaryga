import type { Locator, Page } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import {
  findTradeById,
  insertNewTrade,
  markTradeTelegramSent,
  markMissingTradesAsStale,
  recordTradeAcceptAttempt,
  recordTradeCheckFailure,
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
  type BrowserSession,
} from "./browser.js";
import type { BotSettings, CardRank } from "./domain.js";
import { isFinalTradeStatus, type TradeCard, type TradeRecord } from "./domain.js";
import { isSupportedCardRank, recognizeCardPageRank } from "./ranks.js";
import { passesDefaultRankRule, passesWantedPagesRule } from "./rules.js";
import { sendAuthRequiredNotification, sendTradeProblemNotification } from "./telegram.js";

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
}

export interface TradesLoopOptions {
  signal?: AbortSignal;
  onPass?: (result: TradesPassResult) => void;
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
    };

export async function scanVisibleTrades(
  db: AppDatabase,
  settings: BotSettings,
): Promise<ScanTradesResult> {
  const session = await openSavedMangabuffSession(settings);

  try {
    return await scanVisibleTradesInSession(db, session, settings);
  } catch (error) {
    if (formatError(error) === "Нужна авторизация Mangabuff.") {
      await sendAuthRequiredNotification(settings);
    }

    throw error;
  } finally {
    await session.browser.close();
  }
}

export async function runVisibleTradesLoop(
  db: AppDatabase,
  settings: BotSettings,
  options: TradesLoopOptions = {},
): Promise<void> {
  let session: BrowserSession | undefined;
  let passNumber = 0;

  try {
    while (!options.signal?.aborted) {
      session ??= await openSavedMangabuffSession(settings);
      passNumber += 1;
      const result = await runTradesPass(db, session, settings, passNumber);
      options.onPass?.(result);

      if (result.status === "auth_required") {
        await sendAuthRequiredNotification(settings);
        break;
      }

      if (result.status === "temporary_error" && shouldReopenBrowserSession(result.reason)) {
        await closeBrowserSession(session);
        session = undefined;
      }

      await waitForNextPass(settings.loopPauseMs, options.signal);
    }
  } finally {
    await closeBrowserSession(session);
  }
}

async function runTradesPass(
  db: AppDatabase,
  session: BrowserSession,
  settings: BotSettings,
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

    return { status: "temporary_error", passNumber, reason };
  }
}

async function closeBrowserSession(session: BrowserSession | undefined): Promise<void> {
  await session?.browser.close().catch(() => {});
}

function shouldReopenBrowserSession(reason: string): boolean {
  return reason.includes("Page crashed") || reason.includes("Target page, context or browser has been closed");
}

async function scanVisibleTradesInSession(
  db: AppDatabase,
  session: BrowserSession,
  settings: BotSettings,
): Promise<ScanTradesResult> {
  await openTradesPage(session.page);

  if (!(await isMangabuffAuthorized(session.page))) {
    throw new Error("Нужна авторизация Mangabuff.");
  }

  await openOffersTab(session.page);
  const visibleTrades = await extractVisibleTradeLinks(session.page);
  let insertedCount = 0;

  for (const trade of visibleTrades) {
    if (insertNewTrade(db, trade.tradeId, trade.tradeUrl)) {
      insertedCount += 1;
    }
  }

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

  for (const trade of visibleTrades) {
    const result = await processVisibleTrade(db, session.page, trade, settings);
    await sendProblemNotificationIfNeeded(db, settings, trade.tradeId);

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
    processingStats.skippedCount += result.outcome === "skipped" ? 1 : 0;
  }

  return { visibleTrades, insertedCount, staleCount, ...processingStats };
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

async function processVisibleTrade(
  db: AppDatabase,
  page: Page,
  trade: VisibleTrade,
  settings: BotSettings,
): Promise<ProcessTradeResult> {
  const record = findTradeById(db, trade.tradeId);

  if (!shouldProcessTrade(record, settings)) {
    return { processed: false, outcome: "skipped" };
  }

  try {
    if (record?.status === "принят" && record.acceptAttempts >= 2) {
      const reason = "Обмен снова появился во вкладке предложений после двух попыток принятия.";
      updateTradeStatus(db, trade.tradeId, "требует_ручной_проверки", reason);
      return { processed: true, outcome: "manual_review" };
    }

    await openTradePage(page, trade.tradeUrl);
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

  await openTradePage(page, trade.tradeUrl);
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
  await acceptButton.click({ timeout: 5_000 });
  await confirmAcceptIfNeeded(page);

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

async function confirmAcceptIfNeeded(page: Page): Promise<void> {
  const confirmButton = page
    .locator('[role="dialog"] button, .modal button, [class*="modal"] button, [class*="Modal"] button')
    .filter({ hasText: /^\s*Принять\s*$/ })
    .last();

  if (await confirmButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await confirmButton.click({ timeout: 5_000 });
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(800);
}

async function waitForAcceptedTradeState(page: Page, tradeUrl: string): Promise<boolean> {
  if (await hasAcceptedTradeText(page)) {
    return true;
  }

  await openTradePage(page, tradeUrl);
  return hasAcceptedTradeText(page);
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

async function recognizeCardsRanks(page: Page, cards: TradeCard[]): Promise<TradeCard[]> {
  const rankedCards: TradeCard[] = [];

  for (const card of cards) {
    const recognition = await recognizeCardPageRank(page, card.url);
    rankedCards.push({ ...card, rank: recognition.rank });
  }

  return rankedCards;
}

function formatRankSummary(requestedRank: CardRank, offeredRanks: CardRank[]): string {
  return `запрошена ${requestedRank}, предлагают ${offeredRanks.join(", ")}`;
}

function shouldProcessTrade(record: TradeRecord | undefined, settings: BotSettings): boolean {
  if (!record) {
    return true;
  }

  if (record.status === "бот_бы_принял") {
    return !settings.safeMode && settings.autoAcceptEnabled;
  }

  if (record.status === "принят") {
    return true;
  }

  if (record.status === "ошибка_проверки") {
    return true;
  }

  if (isFinalTradeStatus(record.status)) {
    return false;
  }

  return record.status === "новое";
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
  await openRequestedCardPage(page, requestedCard);
  await openWantedUsersSection(page);
  return countWantedUsersPages(page);
}

async function openRequestedCardPage(page: Page, requestedCard: TradeCard): Promise<void> {
  try {
    await page.goto(requestedCard.url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);
  } catch (error) {
    throw new Error(`не удалось открыть страницу запрошенной карты ${requestedCard.cardId}: ${formatError(error)}`);
  }
}

async function openWantedUsersSection(page: Page): Promise<void> {
  const wantedUsersTab = page.getByText("Хотят получить", { exact: true }).first();

  if (!(await wantedUsersTab.isVisible({ timeout: 5_000 }).catch(() => false))) {
    throw new Error('не удалось найти раздел "Хотят получить" на странице карты');
  }

  await wantedUsersTab.click({ timeout: 5_000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(500);
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

async function openTradePage(page: Page, tradeUrl: string): Promise<void> {
  try {
    await page.goto(tradeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500);
  } catch (error) {
    throw new Error(`Не удалось открыть страницу обмена: ${formatError(error)}`);
  }
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
    const imageTitle = normalizeText(await cardLink.locator("img").first().getAttribute("alt").catch(() => null));
    const linkTitle = normalizeText(await cardLink.innerText().catch(() => ""));

    cards.push({
      cardId,
      url: cardId ? `https://mangabuff.ru/cards/${cardId}/users` : url,
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
    await page.goto(mangabuffTradesUrl, { waitUntil: "domcontentloaded" });
  } catch (error) {
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
}

async function clickFirstVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);

    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    await candidate.click({ timeout: 3_000 });
    return true;
  }

  return false;
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

async function waitForNextPass(loopPauseMs: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(loopPauseMs, undefined, { signal });
  } catch (error) {
    if (!signal?.aborted) {
      throw error;
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
