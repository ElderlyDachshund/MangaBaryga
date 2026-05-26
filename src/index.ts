import "dotenv/config";
import { createDefaultSettings, type TradeCard, type TradeRecord } from "./domain.js";
import { checkMangabuffSession, openSavedMangabuffSession, saveMangabuffSession } from "./browser.js";
import { listTrades, openDatabase } from "./db.js";
import { verifyRankSamples } from "./ranks.js";
import { startControlServer } from "./server.js";
import { runVisibleTradesLoop, scanVisibleTrades, type TradesPassResult } from "./trades.js";
import { assertTelegramConfigured } from "./telegram.js";

const settings = createDefaultSettings();
const command = process.argv[2];
applyCliSettings();

switch (command) {
  case "auth": {
    await saveMangabuffSession();
    break;
  }

  case "check-auth": {
    const isAuthorized = await checkMangabuffSession(settings);
    console.log(isAuthorized ? "Сессия Mangabuff активна." : "Нужна авторизация Mangabuff.");
    process.exitCode = isAuthorized ? 0 : 1;
    break;
  }

  case "scan-trades": {
    assertAutoAcceptIsSafe();
    assertTelegramConfigured(settings);
    const db = openDatabase();
    const result = await scanVisibleTrades(db, settings);

    console.log(`Видимых обменов во вкладке "Предложения": ${result.visibleTrades.length}`);
    console.log(`Новых обменов сохранено: ${result.insertedCount}`);
    console.log(`Пропавших обменов помечено неактуальными: ${result.staleCount}`);
    console.log(`Обменов открыто и проверено: ${result.processedCount}`);
    console.log(`Состав обмена сохранён: ${result.parsedCount}`);
    console.log(`Страниц желающих проверено: ${result.pagesCheckedCount}`);
    console.log(`Брошено по правилам: ${result.rulesDroppedCount}`);
    console.log(`Ранги проверены: ${result.ranksCheckedCount}`);
    console.log(`Safe mode "бот бы принял": ${result.safeAcceptCount}`);
    console.log(`Отправлено на ручную проверку: ${result.manualReviewCount}`);
    console.log(`Технических ошибок проверки: ${result.checkErrorCount}`);
    console.log(`Отменённых или уже принятых обменов помечено неактуальными: ${result.pageStaleCount}`);
    console.log(`Пропущено как уже обработанные: ${result.skippedCount}`);

    for (const trade of result.visibleTrades) {
      console.log(`- ${trade.tradeId}: ${trade.tradeUrl}`);
    }

    break;
  }

  case "run-bot": {
    assertAutoAcceptIsSafe();
    assertTelegramConfigured(settings);
    const db = openDatabase();
    const abortController = new AbortController();

    process.once("SIGINT", () => {
      console.log("\nОстанавливаю бота после текущего безопасного шага...");
      abortController.abort();
    });

    process.once("SIGTERM", () => {
      console.log("\nПолучен сигнал остановки. Закрываю браузерную сессию...");
      abortController.abort();
    });

    console.log('Запускаю постоянный цикл чтения вкладки "Предложения".');
    console.log("Остановка: Ctrl+C.");

    await runVisibleTradesLoop(db, settings, {
      signal: abortController.signal,
      onPass: logTradesPass,
    });

    console.log("Цикл чтения обменов остановлен.");
    break;
  }

  case "list-trades": {
    const db = openDatabase();
    const trades = listTrades(db, readListLimit());

    if (trades.length === 0) {
      console.log("История обменов пуста.");
      break;
    }

    for (const trade of trades) {
      console.log(formatTradeRecord(trade));
    }

    break;
  }

  case "verify-ranks": {
    const session = await openSavedMangabuffSession(settings);

    try {
      const results = await verifyRankSamples(session.page);
      const passedCount = results.filter((result) => result.ok).length;

      console.log(`Проверка распознавания рангов: ${passedCount}/${results.length}`);

      for (const result of results) {
        const status = result.ok ? "OK" : "FAIL";
        const recognized = result.recognizedRank ?? "не распознан";
        const metrics = result.features
          ? `h=${result.features.hue.toFixed(3)} s=${result.features.saturation.toFixed(3)} l=${result.features.lightness.toFixed(3)} color=${result.features.coloredPixelRatio.toFixed(3)}`
          : result.reason;

        console.log(
          `${status} card ${result.cardId}: expected ${result.expectedRank}, recognized ${recognized}; ${metrics}`,
        );
      }

      process.exitCode = passedCount === results.length ? 0 : 1;
    } finally {
      await session.browser.close();
    }

    break;
  }

  case "serve": {
    startControlServer();
    break;
  }

  default: {
    console.log("Mangabuff trade bot scaffold is ready.");
    console.log(`Default mode: ${settings.safeMode ? "safe" : "auto"}`);
    console.log("Commands:");
    console.log("  npm run auth       Войти в Mangabuff вручную и сохранить сессию");
    console.log("  npm run check-auth Проверить сохранённую сессию Mangabuff");
    console.log("  npm run scan-trades Найти видимые входящие обмены и сохранить новые");
    console.log("  npm run list-trades Показать последние записи истории обменов");
    console.log("  npm run run-bot    Постоянно читать вкладку предложений до остановки");
    console.log("  npm run verify-ranks Проверить распознавание рангов на тестовой выборке");
    console.log("  npm run serve      Открыть локальную панель управления");
    console.log("Options:");
    console.log("  --limit=50         Количество записей для list-trades: 1-200");
    console.log("  --headful          Открыть видимый браузер для диагностики");
    console.log("  --pause-ms=6000    Пауза между проходами: 1000-10000 мс");
  }
}

function applyCliSettings(): void {
  settings.telegramBotToken = readOptionalEnv("TELEGRAM_BOT_TOKEN");
  settings.telegramChatId = readOptionalEnv("TELEGRAM_CHAT_ID");

  if (process.argv.includes("--headful")) {
    settings.browserMode = "headful";
  }

  const pauseArg = process.argv.find((arg) => arg.startsWith("--pause-ms="));

  if (!pauseArg) {
    return;
  }

  const pauseMs = Number(pauseArg.split("=")[1]);

  if (!Number.isInteger(pauseMs) || pauseMs < 1_000 || pauseMs > 10_000) {
    throw new Error("Пауза между проходами должна быть целым числом от 1000 до 10000 мс.");
  }

  settings.loopPauseMs = pauseMs;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function logTradesPass(result: TradesPassResult): void {
  const time = new Date().toLocaleString("ru-RU");

  if (result.status === "auth_required") {
    console.log(`[${time}] Проход ${result.passNumber}: нужна повторная авторизация Mangabuff.`);
    return;
  }

  if (result.status === "temporary_error") {
    console.log(`[${time}] Проход ${result.passNumber}: временная ошибка, попробую снова. ${result.reason}`);
    return;
  }

  console.log(
    `[${time}] Проход ${result.passNumber}: видимых ${result.visibleTrades.length}, новых ${result.insertedCount}, страницы проверены ${result.pagesCheckedCount}, ранги проверены ${result.ranksCheckedCount}, бот бы принял ${result.safeAcceptCount}, брошено по правилам ${result.rulesDroppedCount}, ручная проверка ${result.manualReviewCount}, ошибок ${result.checkErrorCount}, неактуальных ${result.staleCount + result.pageStaleCount}, пропущено ${result.skippedCount}.`,
  );
}

function readListLimit(): number {
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));

  if (!limitArg) {
    return 20;
  }

  const limit = Number(limitArg.split("=")[1]);

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Лимит истории должен быть целым числом от 1 до 200.");
  }

  return limit;
}

function formatTradeRecord(trade: TradeRecord): string {
  return [
    `#${trade.tradeId} ${trade.status}`,
    `  Обновлён: ${trade.updatedAt}; найден: ${trade.discoveredAt}`,
    `  Пользователь: ${trade.senderName ?? "не удалось определить"}`,
    `  Забирают: ${formatCards(trade.requestedCards)}`,
    `  Предлагают: ${formatCards(trade.offeredCards)}`,
    `  Страниц желающих: ${trade.wantedPagesCount ?? "не проверялось"}`,
    `  Ранговое правило: ${trade.rankRuleResult}`,
    `  Попытки проверки: ${trade.checkAttempts}; попытки принятия: ${trade.acceptAttempts}`,
    `  Последняя попытка принятия: ${trade.lastAcceptAttemptedAt ?? "не было"}`,
    `  Telegram: ${trade.telegramSent ? "отправлен" : "не отправлялся"}`,
    `  Причина: ${trade.reason || "не указана"}`,
    `  Ссылка: ${trade.tradeUrl}`,
  ].join("\n");
}

function formatCards(cards: TradeCard[]): string {
  if (cards.length === 0) {
    return "не удалось определить";
  }

  return cards.map(formatCard).join(", ");
}

function formatCard(card: TradeCard): string {
  const title = card.title ? `${card.title} ` : "";
  const rank = card.rank ? ` rank ${card.rank}` : "";

  return `${title}#${card.cardId}${rank}`;
}

function assertAutoAcceptIsSafe(): void {
  if (!settings.autoAcceptEnabled) {
    return;
  }

  if (!settings.rankRecognitionVerified) {
    throw new Error(
      "Автоматическое принятие заблокировано: распознавание рангов не реализовано и не проверено.",
    );
  }
}
