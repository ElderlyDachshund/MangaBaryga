import type { BotSettings, TradeRecord } from "../domain";

export type ApiRuntimePass =
  | {
      status: "ok";
      passNumber: number;
      visibleTrades: Array<{ tradeId: string; tradeUrl: string }>;
      insertedCount: number;
      staleCount: number;
      processedCount: number;
      parsedCount: number;
      pagesCheckedCount: number;
      rulesDroppedCount: number;
      ranksCheckedCount: number;
      safeAcceptCount: number;
      acceptedCount: number;
      manualReviewCount: number;
      checkErrorCount: number;
      pageStaleCount: number;
      skippedCount: number;
    }
  | {
      status: "auth_required";
      passNumber: number;
    }
  | {
      status: "temporary_error";
      passNumber: number;
      reason: string;
    };

export interface ApiSettings {
  telegramConfigured: boolean;
  telegramChatId?: string;
  safeMode: boolean;
  autoAcceptEnabled: boolean;
  autoAcceptLocked: boolean;
  maxWantedPagesExclusive: number;
  lockAllWantedPagesThreshold: number;
  lockRecentWantedPagesThreshold: number;
  lockRecentCardsLimit: number;
  loopPauseMs: number;
  browserMode: BotSettings["browserMode"];
  rankRecognitionVerified: boolean;
}

export interface ApiState {
  settings: ApiSettings;
  runtime: {
    running: boolean;
    stopping: boolean;
    startedAt?: string;
    stoppedAt?: string;
    lastPass?: ApiRuntimePass;
    lastError?: string;
  };
  cardLocking: {
    status: "idle" | "running" | "stopping" | "completed" | "cancelled" | "error";
    mode?: "all" | "recent";
    threshold?: number;
    requestedLimit?: number;
    totalCount?: number;
    checkedCount: number;
    lockedCount: number;
    alreadyLockedCount: number;
    belowThresholdCount: number;
    errorCount: number;
    pagesProcessed: number;
    currentPage?: number;
    currentCardId?: string;
    errors: Array<{
      cardId?: string;
      instanceId?: string;
      page?: number;
      reason: string;
    }>;
    startedAt?: string;
    finishedAt?: string;
    lastError?: string;
  };
  auth: {
    authorized?: boolean;
    lastAttemptAt?: string;
    lastFailureReason?: string;
    lastSuccessAt?: string;
    manualAuthActive: boolean;
    recoveryScheduledAt?: string;
  };
  trades: TradeRecord[];
}

export interface SettingsPatch {
  telegramBotToken?: string;
  telegramChatId?: string;
  maxWantedPagesExclusive?: number;
  lockAllWantedPagesThreshold?: number;
  lockRecentWantedPagesThreshold?: number;
  lockRecentCardsLimit?: number;
  loopPauseMs?: number;
  browserMode?: BotSettings["browserMode"];
  safeMode?: boolean;
  autoAcceptEnabled?: boolean;
}

export async function loadState(): Promise<ApiState> {
  return request<ApiState>("/api/state");
}

export async function saveSettings(patch: SettingsPatch): Promise<ApiSettings> {
  return request<ApiSettings>("/api/settings", {
    body: JSON.stringify(patch),
    method: "PATCH",
  });
}

export async function startBot(): Promise<ApiState> {
  return request<ApiState>("/api/bot/start", { method: "POST" });
}

export async function stopBot(): Promise<ApiState> {
  return request<ApiState>("/api/bot/stop", { method: "POST" });
}

export async function startCardLocking(options: {
  mode: "all" | "recent";
  threshold: number;
  recentLimit?: number;
}): Promise<ApiState> {
  return request<ApiState>("/api/card-locking/start", {
    body: JSON.stringify(options),
    method: "POST",
  });
}

export async function stopCardLocking(): Promise<ApiState> {
  return request<ApiState>("/api/card-locking/stop", { method: "POST" });
}

export async function startAuth(): Promise<{ active: boolean }> {
  return request<{ active: boolean }>("/api/auth/start", { method: "POST" });
}

export async function completeAuth(): Promise<{ saved: boolean }> {
  return request<{ saved: boolean }>("/api/auth/complete", { method: "POST" });
}

export async function cancelAuth(): Promise<{ active: boolean }> {
  return request<{ active: boolean }>("/api/auth/cancel", { method: "POST" });
}

export async function checkAuth(): Promise<{ authorized: boolean }> {
  return request<{ authorized: boolean }>("/api/auth/status");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const payload = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : "Запрос не выполнен");
  }

  return payload as T;
}

function apiUrl(path: string): string {
  const baseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

  if (!baseUrl) {
    return path;
  }

  return new URL(path, ensureTrailingSlash(baseUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
