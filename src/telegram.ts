import type { BotSettings, TradeCard, TradeRecord } from "./domain.js";

interface TelegramSettings extends BotSettings {
  telegramBotToken: string;
  telegramChatId: string;
}

export function assertTelegramConfigured(settings: BotSettings): asserts settings is TelegramSettings {
  if (!settings.telegramBotToken || !settings.telegramChatId) {
    throw new Error(
      "Telegram не настроен: укажи TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env.",
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
  const response = await fetch(
    `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: settings.telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    },
  );

  if (response.ok) {
    return;
  }

  const responseText = await response.text().catch(() => "");
  const details = responseText ? ` ${responseText.slice(0, 300)}` : "";
  throw new Error(`Telegram вернул ошибку ${response.status}.${details}`);
}
