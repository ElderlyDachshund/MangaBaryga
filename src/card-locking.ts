import type { MangabuffHttpSession, MangabuffSessionClient } from "./mangabuff-http.js";
import { formatError } from "./logger.js";
import { buildWantedOffersUrl, countWantedUsersPagesFromHtml } from "./wanted-pages.js";

export type CardLockingMode = "all" | "recent";

export interface CardLockingError {
  cardId?: string;
  instanceId?: string;
  page?: number;
  reason: string;
}

export interface CardLockingProgress {
  mode: CardLockingMode;
  threshold: number;
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
  errors: CardLockingError[];
}

export interface CardLockingResult extends CardLockingProgress {
  cancelled: boolean;
}

interface OwnedCardInstance {
  cardId?: string;
  instanceId?: string;
  locked?: boolean;
  title?: string;
}

interface OwnedCardsPage {
  csrfToken?: string;
  instances: OwnedCardInstance[];
  totalCount?: number;
}

const mangabuffBaseUrl = "https://mangabuff.ru";
const maxReportedErrors = 200;

export async function runCardLockingInHttpSession(
  session: MangabuffSessionClient,
  options: {
    mode: CardLockingMode;
    threshold: number;
    recentLimit?: number;
    signal?: AbortSignal;
    onProgress?: (progress: CardLockingProgress) => void;
  },
): Promise<CardLockingResult> {
  const recentLimit = options.mode === "recent" ? normalizeRecentLimit(options.recentLimit) : undefined;
  const progress: CardLockingProgress = {
    mode: options.mode,
    threshold: normalizeThreshold(options.threshold),
    requestedLimit: recentLimit,
    checkedCount: 0,
    lockedCount: 0,
    alreadyLockedCount: 0,
    belowThresholdCount: 0,
    errorCount: 0,
    pagesProcessed: 0,
    errors: [],
  };
  const userId = await readAuthenticatedUserId(session);
  const wantedPagesCache = new Map<string, number>();
  const seenInstanceIds = new Set<string>();
  let pageNumber = 1;

  while (!options.signal?.aborted) {
    const pageUrl = buildOwnedCardsPageUrl(userId, options.mode, pageNumber);
    const response = await getTextWithRetry(session, pageUrl);

    if (!response.ok) {
      throw new Error(`Не удалось открыть страницу ${pageNumber} коллекции: HTTP ${response.status}.`);
    }

    const parsedPage = parseOwnedCardsPage(response.text);

    if (pageNumber === 1) {
      progress.totalCount =
        parsedPage.totalCount === undefined
          ? recentLimit
          : recentLimit === undefined
            ? parsedPage.totalCount
            : Math.min(parsedPage.totalCount, recentLimit);
    }

    if (parsedPage.instances.length === 0) {
      break;
    }

    const remaining =
      recentLimit === undefined ? parsedPage.instances.length : Math.max(0, recentLimit - progress.checkedCount);
    const pageInstances = parsedPage.instances
      .filter((instance) => !instance.instanceId || !seenInstanceIds.has(instance.instanceId))
      .slice(0, remaining);

    if (pageInstances.length === 0) {
      break;
    }

    progress.currentPage = pageNumber;
    const instanceIdsToLock: string[] = [];
    const lockCandidates: OwnedCardInstance[] = [];

    for (const instance of pageInstances) {
      if (options.signal?.aborted) {
        break;
      }

      if (instance.instanceId) {
        seenInstanceIds.add(instance.instanceId);
      }

      progress.currentCardId = instance.cardId;

      if (!instance.cardId || !instance.instanceId || instance.locked === undefined) {
        addProgressError(progress, {
          cardId: instance.cardId,
          instanceId: instance.instanceId,
          page: pageNumber,
          reason: buildIncompleteCardReason(instance),
        });
        progress.checkedCount += 1;
        emitProgress(options.onProgress, progress);
        continue;
      }

      if (instance.locked) {
        progress.alreadyLockedCount += 1;
        progress.checkedCount += 1;
        emitProgress(options.onProgress, progress);
        continue;
      }

      try {
        let wantedPagesCount = wantedPagesCache.get(instance.cardId);

        if (wantedPagesCount === undefined) {
          const wantedResponse = await getTextWithRetry(session, buildWantedOffersUrl(instance.cardId));

          if (!wantedResponse.ok) {
            throw new Error(`HTTP ${wantedResponse.status}`);
          }

          wantedPagesCount = countWantedUsersPagesFromHtml(wantedResponse.text);
          wantedPagesCache.set(instance.cardId, wantedPagesCount);
        }

        if (wantedPagesCount >= progress.threshold) {
          instanceIdsToLock.push(instance.instanceId);
          lockCandidates.push(instance);
        } else {
          progress.belowThresholdCount += 1;
        }
      } catch (error) {
        addProgressError(progress, {
          cardId: instance.cardId,
          instanceId: instance.instanceId,
          page: pageNumber,
          reason: `Не удалось проверить страницы желающих: ${formatError(error)}`,
        });
      }

      progress.checkedCount += 1;
      emitProgress(options.onProgress, progress);
    }

    if (!options.signal?.aborted && instanceIdsToLock.length > 0) {
      try {
        await explicitlyLockCardInstances(session, pageUrl, parsedPage.csrfToken, instanceIdsToLock);
        progress.lockedCount += instanceIdsToLock.length;
      } catch (error) {
        for (const instance of lockCandidates) {
          addProgressError(progress, {
            cardId: instance.cardId,
            instanceId: instance.instanceId,
            page: pageNumber,
            reason: `Не удалось заблокировать экземпляр: ${formatError(error)}`,
          });
        }
      }
    }

    progress.pagesProcessed += 1;
    progress.currentCardId = undefined;
    emitProgress(options.onProgress, progress);

    if (recentLimit !== undefined && progress.checkedCount >= recentLimit) {
      break;
    }

    if (progress.totalCount !== undefined && progress.checkedCount >= progress.totalCount) {
      break;
    }

    pageNumber += 1;
  }

  progress.currentCardId = undefined;
  progress.currentPage = undefined;
  emitProgress(options.onProgress, progress);

  return {
    ...progress,
    errors: [...progress.errors],
    cancelled: Boolean(options.signal?.aborted),
  };
}

export async function saveCardLockingSession(session: MangabuffSessionClient): Promise<void> {
  if ("saveStorageState" in session) {
    await (session as MangabuffHttpSession).saveStorageState();
  }
}

export function parseOwnedCardsPage(html: string): OwnedCardsPage {
  const itemMatches = [...html.matchAll(/<div\b[^>]*>/gi)].filter((match) =>
    hasHtmlClass(match[0], "manga-cards__item"),
  );
  const instances = itemMatches.map((match, index) => {
    const itemTag = match[0];
    const start = match.index ?? 0;
    const end = itemMatches[index + 1]?.index ?? html.length;
    const itemHtml = html.slice(start, end);
    const lockButtonTag = itemHtml.match(
      /<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\block-card-btn\b[^"']*\1[^>]*>/i,
    )?.[0];
    const lockIconTag = lockButtonTag
      ? itemHtml.slice(itemHtml.indexOf(lockButtonTag) + lockButtonTag.length).match(
          /<i\b[^>]*\bclass\s*=\s*(["'])[^"']*\bicon-(?:un)?lock\b[^"']*\1[^>]*>/i,
        )?.[0]
      : undefined;

    return {
      cardId: readHtmlAttribute(itemTag, "data-card-id"),
      instanceId: lockButtonTag ? readHtmlAttribute(lockButtonTag, "data-id") : undefined,
      locked: lockIconTag ? hasHtmlClass(lockIconTag, "icon-lock") : undefined,
      title: readHtmlAttribute(itemTag, "data-name"),
    };
  });
  const totalCountText = html.match(/<h[1-6]\b[^>]*>\s*Карточки\s+([\d\s]+)/i)?.[1];
  const totalCount = totalCountText ? Number(totalCountText.replace(/\s+/g, "")) : undefined;

  return {
    csrfToken: readCsrfTokenFromHtml(html),
    instances,
    totalCount: Number.isInteger(totalCount) ? totalCount : undefined,
  };
}

function buildOwnedCardsPageUrl(userId: string, mode: CardLockingMode, pageNumber: number): string {
  const url = new URL(`/users/${userId}/cards`, mangabuffBaseUrl);

  if (mode === "recent") {
    url.searchParams.set("sort", "new");
  }

  if (pageNumber > 1) {
    url.searchParams.set("page", String(pageNumber));
  }

  return url.href;
}

async function readAuthenticatedUserId(session: MangabuffSessionClient): Promise<string> {
  const response = await getTextWithRetry(session, `${mangabuffBaseUrl}/`);

  if (!response.ok || new URL(response.url).pathname.includes("login")) {
    throw new Error("Нужна авторизация Mangabuff.");
  }

  const isAuth = response.text.match(/\bwindow\.isAuth\s*=\s*(\d+)/)?.[1];
  const userId = response.text.match(/\bwindow\.user_id\s*=\s*(\d+)/)?.[1];

  if (isAuth !== "1" || !userId || userId === "0") {
    throw new Error("Не удалось определить авторизованный аккаунт Mangabuff.");
  }

  return userId;
}

async function explicitlyLockCardInstances(
  session: MangabuffSessionClient,
  referer: string,
  csrfToken: string | undefined,
  instanceIds: string[],
): Promise<void> {
  if (!csrfToken) {
    throw new Error("на странице коллекции отсутствует CSRF-токен");
  }

  const body = new URLSearchParams();

  for (const instanceId of instanceIds) {
    body.append("card_ids[]", instanceId);
  }

  body.set("is_lock", "1");
  const response = await session.postForm(`${mangabuffBaseUrl}/trades/lockCards`, body, {
    csrfToken,
    referer,
  });

  if (!response.ok) {
    const message =
      typeof response.json === "object" &&
      response.json !== null &&
      "message" in response.json &&
      typeof response.json.message === "string"
        ? response.json.message
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
}

async function getTextWithRetry(session: MangabuffSessionClient, url: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await session.getText(url);

      if (response.ok || (response.status !== 429 && response.status < 500)) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(formatError(lastError));
}

function readCsrfTokenFromHtml(html: string): string | undefined {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const metaTag of metaTags) {
    if (readHtmlAttribute(metaTag, "name") === "csrf-token") {
      return readHtmlAttribute(metaTag, "content");
    }
  }

  return undefined;
}

function readHtmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, "is"));
  return match?.[2] ? decodeHtmlAttributeValue(match[2]) : undefined;
}

function hasHtmlClass(tag: string, className: string): boolean {
  return readHtmlAttribute(tag, "class")?.split(/\s+/).includes(className) ?? false;
}

function decodeHtmlAttributeValue(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildIncompleteCardReason(instance: OwnedCardInstance): string {
  const missing: string[] = [];

  if (!instance.cardId) {
    missing.push("ID карты");
  }

  if (!instance.instanceId) {
    missing.push("ID экземпляра");
  }

  if (instance.locked === undefined) {
    missing.push("состояние замка");
  }

  return `Не удалось определить: ${missing.join(", ")}.`;
}

function addProgressError(progress: CardLockingProgress, error: CardLockingError): void {
  progress.errorCount += 1;

  if (progress.errors.length < maxReportedErrors) {
    progress.errors.push(error);
  }
}

function emitProgress(
  callback: ((progress: CardLockingProgress) => void) | undefined,
  progress: CardLockingProgress,
): void {
  callback?.({
    ...progress,
    errors: [...progress.errors],
  });
}

function normalizeThreshold(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Порог страниц желающих должен быть целым числом от 1 до 100.");
  }

  return value;
}

function normalizeRecentLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1 || (value ?? 0) > 100_000) {
    throw new Error("Количество недавних карт должно быть целым числом от 1 до 100000.");
  }

  return value as number;
}
