export const tradeStatuses = [
  "новое",
  "ошибка_проверки",
  "требует_ручной_проверки",
  "брошен_по_правилам",
  "принят",
  "бот_бы_принял",
  "неактуален",
] as const;

export type TradeStatus = (typeof tradeStatuses)[number];

export const rankRuleResults = [
  "не_проверялось",
  "выполнено",
  "не_выполнено",
] as const;

export type RankRuleResult = (typeof rankRuleResults)[number];

export const finalTradeStatuses = [
  "требует_ручной_проверки",
  "брошен_по_правилам",
  "бот_бы_принял",
  "неактуален",
] as const satisfies readonly TradeStatus[];

export const supportedRanks = ["E", "D", "C", "B", "G", "P", "A", "S"] as const;

export const unknownRank = "unknown" as const;

export const recognizableRanks = [...supportedRanks, unknownRank] as const;

export type SupportedCardRank = (typeof supportedRanks)[number];

export type CardRank = (typeof recognizableRanks)[number];

export interface TradeCard {
  cardId: string;
  url: string;
  imageUrl?: string;
  title?: string;
  rank?: CardRank;
}

export interface TradeRecord {
  tradeId: string;
  tradeUrl: string;
  status: TradeStatus;
  reason: string;
  senderName?: string;
  requestedCards: TradeCard[];
  offeredCards: TradeCard[];
  wantedPagesCount?: number;
  rankRuleResult: RankRuleResult;
  checkAttempts: number;
  acceptAttempts: number;
  lastAcceptAttemptedAt?: string;
  telegramSent: boolean;
  discoveredAt: string;
  updatedAt: string;
}

export interface BotSettings {
  telegramBotToken?: string;
  telegramChatId?: string;
  safeMode: boolean;
  autoAcceptEnabled: boolean;
  maxWantedPagesExclusive: number;
  lockAllWantedPagesThreshold: number;
  lockRecentWantedPagesThreshold: number;
  lockRecentCardsLimit: number;
  loopPauseMs: number;
  browserMode: "headless" | "headful";
  rankRecognitionVerified: boolean;
}

export function createDefaultSettings(): BotSettings {
  return {
    safeMode: true,
    autoAcceptEnabled: false,
    maxWantedPagesExclusive: 5,
    lockAllWantedPagesThreshold: 5,
    lockRecentWantedPagesThreshold: 5,
    lockRecentCardsLimit: 100,
    loopPauseMs: 5_000,
    browserMode: "headless",
    rankRecognitionVerified: false,
  };
}

export function isFinalTradeStatus(status: TradeStatus): boolean {
  return finalTradeStatuses.includes(status as (typeof finalTradeStatuses)[number]);
}
