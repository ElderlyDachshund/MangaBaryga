export function buildWantedOffersUrl(cardId: string): string {
  return `https://mangabuff.ru/cards/${cardId}/offers/want`;
}

export function countWantedUsersPagesFromHtml(html: string): number {
  const paginationPagesCount = readPaginationPagesCountFromHtml(html);

  if (paginationPagesCount !== undefined) {
    return paginationPagesCount;
  }

  const text = htmlToText(html);

  if (hasEmptyWantedUsersText(text)) {
    return 0;
  }

  if (html.includes("card-show__owner") || /href=["']\/users\/\d+/i.test(html)) {
    return 1;
  }

  return 0;
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

function hasEmptyWantedUsersText(text: string): boolean {
  return [
    "никто не хочет получить",
    "нет желающих",
    "нет пользователей",
    "пользователей не найдено",
    "список пуст",
  ].some((emptyText) => text.includes(emptyText));
}

function normalizeText(value: string | null | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}
