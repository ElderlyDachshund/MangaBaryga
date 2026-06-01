import { Bot, GrammyError, HttpError as GrammyHttpError } from "grammy";
import type { BotSettings, TradeCard, TradeRecord } from "./domain.js";

interface TelegramSettings extends BotSettings {
  telegramBotToken: string;
  telegramChatId: string;
}

let cachedBotToken: string | undefined;
let cachedBot: Bot | undefined;

export function assertTelegramConfigured(settings: BotSettings): asserts settings is TelegramSettings {
  if (!settings.telegramBotToken || !settings.telegramChatId) {
    throw new Error(
      "Telegram не настроен: укажи MANGA_TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env.",
    );
  }
}

export async function sendTradeProblemNotification(
  settings: BotSettings,
  trade: TradeRecord,
): Promise<void> {
  assertTelegramConfigured(settings);
  await sendTelegramMessage(settings, formatTradeProblemMessage(trade));
}

export async function sendAuthRequiredNotification(settings: BotSettings): Promise<void> {
  assertTelegramConfigured(settings);
  await sendTelegramMessage(settings, "Нужно заново войти в Mangabuff");
}

function formatTradeProblemMessage(trade: TradeRecord): string {
  return [
    "Проблемный обмен Mangabuff",
    `Статус: ${trade.status}`,
    `Причина: ${trade.reason || "не удалось определить"}`,
    `Пользователь: ${trade.senderName || "не удалось определить"}`,
    `Забирают: ${formatCards(trade.requestedCards)}`,
    `Предлагают: ${formatCards(trade.offeredCards)}`,
    `Страниц желающих: ${trade.wantedPagesCount ?? "не удалось определить"}`,
    `Ранговое правило: ${formatRankRuleResult(trade.rankRuleResult)}`,
    `Ссылка: ${trade.tradeUrl}`,
  ].join("\n");
}

function formatCards(cards: TradeCard[]): string {
  if (cards.length === 0) {
    return "-";
  }

  return cards.map(formatCard).join(", ");
}

function formatCard(card: TradeCard): string {
  return `Карточка (ранг ${card.rank ?? "-"})`;
}

function formatRankRuleResult(result: TradeRecord["rankRuleResult"]): string {
  switch (result) {
    case "выполнено":
      return "выполнено";
    case "не_выполнено":
      return "не выполнено";
    case "не_проверялось":
      return "не удалось определить";
  }
}

async function sendTelegramMessage(settings: TelegramSettings, text: string): Promise<void> {
  try {
    await getTelegramBot(settings.telegramBotToken).api.sendMessage(settings.telegramChatId, text, {
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    if (error instanceof GrammyError) {
      throw new Error(`Telegram вернул ошибку ${error.error_code}: ${error.description}`);
    }

    if (error instanceof GrammyHttpError) {
      throw new Error(`Telegram недоступен: ${error.message}`);
    }

    throw error;
  }
}

function getTelegramBot(token: string): Bot {
  if (cachedBot && cachedBotToken === token) {
    return cachedBot;
  }

  cachedBotToken = token;
  cachedBot = new Bot(token);

  return cachedBot;
}
