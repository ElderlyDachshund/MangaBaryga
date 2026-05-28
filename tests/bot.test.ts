import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createDefaultSettings } from "../src/domain.js";
import {
  findTradeById,
  insertNewTrade,
  markMissingTradesAsStale,
  markTradeTelegramSent,
  openDatabase,
  recordTradeCheckFailure,
  updateTradeStatus,
  type AppDatabase,
} from "../src/db.js";
import type {
  MangabuffBytesResponse,
  MangabuffJsonResponse,
  MangabuffSessionClient,
  MangabuffTextResponse,
} from "../src/mangabuff-http.js";
import { scanVisibleTradesInHttpSession } from "../src/trades.js";

const tradesUrl = "https://mangabuff.ru/trades";

test("HTTP-scan keeps browser entry points out of the bot run path", async () => {
  const source = await readFile(join(process.cwd(), "src/trades.ts"), "utf8");
  const scanFunction = readFunctionBlock(source, "scanVisibleTrades");
  const loopFunction = readFunctionBlock(source, "runVisibleTradesLoop");

  assert.match(scanFunction, /openSavedMangabuffHttpSession/);
  assert.doesNotMatch(scanFunction, /openSavedMangabuffSession/);
  assert.match(loopFunction, /openSavedMangabuffHttpSession/);
  assert.doesNotMatch(loopFunction, /openSavedMangabuffSession/);
});

test("safe mode records an exchange that passes rules without accepting it", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const requestedImage = await createRankImage(0.56, 0.8, 0.3);
    const offeredImage = await createRankImage(0.09, 0.8, 0.35);
    const settings = createDefaultSettings();

    settings.maxWantedPagesExclusive = 10;

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1001"])));
    session.queueText(
      "https://mangabuff.ru/trades/1001",
      htmlResponse("https://mangabuff.ru/trades/1001", activeTradeHtml({ tradeId: "1001" })),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(1)),
    );
    session.setBytes("https://mangabuff.ru/img/cards/requested-d.png", requestedImage);
    session.setBytes("https://mangabuff.ru/img/cards/offered-c.png", offeredImage);

    const result = await scanVisibleTradesInHttpSession(db, session, createDefaultSettings());
    const trade = findTradeById(db, "1001");

    assert.equal(result.visibleTrades.length, 1);
    assert.equal(result.insertedCount, 1);
    assert.equal(result.processedCount, 1);
    assert.equal(result.pagesCheckedCount, 1);
    assert.equal(result.ranksCheckedCount, 1);
    assert.equal(result.safeAcceptCount, 1);
    assert.equal(result.acceptedCount, 0);
    assert.equal(trade?.status, "бот_бы_принял");
    assert.equal(trade?.acceptAttempts, 0);
    assert.equal(session.posts.length, 0);
  });
});

test("wanted-pages check reads the card wanted-offers page instead of owners page", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const requestedImage = await createRankImage(0.56, 0.8, 0.3);
    const offeredImage = await createRankImage(0.09, 0.8, 0.35);

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1007"])));
    session.queueText(
      "https://mangabuff.ru/trades/1007",
      htmlResponse("https://mangabuff.ru/trades/1007", activeTradeHtml({ tradeId: "1007" })),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/users",
      htmlResponse("https://mangabuff.ru/cards/201/users", ownersHtml(56)),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(1)),
    );
    session.setBytes("https://mangabuff.ru/img/cards/requested-d.png", requestedImage);
    session.setBytes("https://mangabuff.ru/img/cards/offered-c.png", offeredImage);

    await scanVisibleTradesInHttpSession(db, session, createDefaultSettings());
    const trade = findTradeById(db, "1007");

    assert.equal(trade?.wantedPagesCount, 1);
    assert.equal(trade?.requestedCards[0]?.url, "https://mangabuff.ru/cards/201/offers/want");
    assert.ok(session.textUrls.includes("https://mangabuff.ru/cards/201/offers/want"));
    assert.ok(!session.textUrls.includes("https://mangabuff.ru/cards/201/users"));
  });
});

test("wanted-pages check uses the highest page number from current links", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const requestedImage = await createRankImage(0.56, 0.8, 0.3);
    const offeredImage = await createRankImage(0.09, 0.8, 0.35);
    const settings = createDefaultSettings();

    settings.maxWantedPagesExclusive = 10;

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1009"])));
    session.queueText(
      "https://mangabuff.ru/trades/1009",
      htmlResponse("https://mangabuff.ru/trades/1009", activeTradeHtml({ tradeId: "1009" })),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse(
        "https://mangabuff.ru/cards/201/offers/want",
        wantedUsersHtmlWithLinks([
          "/cards/201/offers/want?page=2",
          "https://mangabuff.ru/cards/201/offers/want?page=3",
          "https://mangabuff.ru/cards/201/offers/want?only=friends&amp;page=9",
          "https://mangabuff.ru/cards/201/offers/want?page=2",
        ]),
      ),
    );
    session.setBytes("https://mangabuff.ru/img/cards/requested-d.png", requestedImage);
    session.setBytes("https://mangabuff.ru/img/cards/offered-c.png", offeredImage);

    await scanVisibleTradesInHttpSession(db, session, settings);
    const trade = findTradeById(db, "1009");

    assert.equal(trade?.wantedPagesCount, 9);
  });
});

test("wanted-pages check ignores legacy owners card links from trade HTML", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const requestedImage = await createRankImage(0.56, 0.8, 0.3);
    const offeredImage = await createRankImage(0.09, 0.8, 0.35);

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1008"])));
    session.queueText(
      "https://mangabuff.ru/trades/1008",
      htmlResponse(
        "https://mangabuff.ru/trades/1008",
        activeTradeHtml({
          requestedCards: [
            { href: "/cards/201/users", id: "201", image: "/img/cards/requested-d.png", title: "Requested D" },
          ],
          tradeId: "1008",
        }),
      ),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(1)),
    );
    session.setBytes("https://mangabuff.ru/img/cards/requested-d.png", requestedImage);
    session.setBytes("https://mangabuff.ru/img/cards/offered-c.png", offeredImage);

    await scanVisibleTradesInHttpSession(db, session, createDefaultSettings());
    const trade = findTradeById(db, "1008");

    assert.equal(trade?.wantedPagesCount, 1);
    assert.equal(trade?.requestedCards[0]?.url, "https://mangabuff.ru/cards/201/offers/want");
    assert.deepEqual(
      session.textUrls.filter((url) => url.includes("/cards/201/")),
      ["https://mangabuff.ru/cards/201/offers/want"],
    );
  });
});

test("auto mode accepts a passing exchange through HTTP with CSRF and referer", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const requestedImage = await createRankImage(0.56, 0.8, 0.3);
    const offeredImage = await createRankImage(0.09, 0.8, 0.35);
    const settings = createDefaultSettings();

    settings.safeMode = false;
    settings.autoAcceptEnabled = true;

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1002"])));
    session.queueText(
      "https://mangabuff.ru/trades/1002",
      htmlResponse("https://mangabuff.ru/trades/1002", activeTradeHtml({ tradeId: "1002", csrfToken: "csrf-1002" })),
      htmlResponse("https://mangabuff.ru/trades/1002", activeTradeHtml({ tradeId: "1002", csrfToken: "csrf-1002" })),
      htmlResponse("https://mangabuff.ru/trades/1002", "<html><body>Обмен принят</body></html>"),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(1)),
    );
    session.setBytes("https://mangabuff.ru/img/cards/requested-d.png", requestedImage);
    session.setBytes("https://mangabuff.ru/img/cards/offered-c.png", offeredImage);

    const result = await scanVisibleTradesInHttpSession(db, session, settings);
    const trade = findTradeById(db, "1002");

    assert.equal(result.acceptedCount, 1);
    assert.equal(trade?.status, "принят");
    assert.equal(trade?.acceptAttempts, 1);
    assert.deepEqual(session.posts, [
      {
        data: {},
        options: {
          csrfToken: "csrf-1002",
          referer: "https://mangabuff.ru/trades/1002",
        },
        url: "https://mangabuff.ru/trades/1002/accept",
      },
    ]);
  });
});

test("HTTP scan uses fresh mode settings before processing each visible exchange", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const requestedImage = await createRankImage(0.56, 0.8, 0.3);
    const offeredImage = await createRankImage(0.09, 0.8, 0.35);
    const autoSettings = createDefaultSettings();
    const safeSettings = createDefaultSettings();

    autoSettings.safeMode = false;
    autoSettings.autoAcceptEnabled = true;
    autoSettings.maxWantedPagesExclusive = 10;
    safeSettings.maxWantedPagesExclusive = 10;

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1010", "1011"])));
    session.queueText(
      "https://mangabuff.ru/trades/1010",
      htmlResponse("https://mangabuff.ru/trades/1010", activeTradeHtml({ tradeId: "1010", csrfToken: "csrf-1010" })),
      htmlResponse("https://mangabuff.ru/trades/1010", activeTradeHtml({ tradeId: "1010", csrfToken: "csrf-1010" })),
      htmlResponse("https://mangabuff.ru/trades/1010", "<html><body>Обмен принят</body></html>"),
    );
    session.queueText(
      "https://mangabuff.ru/trades/1011",
      htmlResponse("https://mangabuff.ru/trades/1011", activeTradeHtml({ tradeId: "1011", csrfToken: "csrf-1011" })),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(1)),
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(1)),
    );
    session.setBytes("https://mangabuff.ru/img/cards/requested-d.png", requestedImage);
    session.setBytes("https://mangabuff.ru/img/cards/offered-c.png", offeredImage);

    const result = await scanVisibleTradesInHttpSession(
      db,
      session,
      () => (session.posts.length > 0 ? safeSettings : autoSettings),
    );

    assert.equal(result.acceptedCount, 1);
    assert.equal(result.safeAcceptCount, 1);
    assert.equal(findTradeById(db, "1010")?.status, "принят");
    assert.equal(findTradeById(db, "1011")?.status, "бот_бы_принял");
    assert.deepEqual(
      session.posts.map((post) => post.url),
      ["https://mangabuff.ru/trades/1010/accept"],
    );
  });
});

test("exchange with several requested cards goes to manual review before extra checks", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();

    insertNewTrade(db, "1003", "https://mangabuff.ru/trades/1003");
    markTradeTelegramSent(db, "1003");

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1003"])));
    session.queueText(
      "https://mangabuff.ru/trades/1003",
      htmlResponse(
        "https://mangabuff.ru/trades/1003",
        activeTradeHtml({
          requestedCards: [
            { id: "201", image: "/img/cards/requested-d.png", title: "Requested D" },
            { id: "202", image: "/img/cards/requested-d-2.png", title: "Requested D 2" },
          ],
          tradeId: "1003",
        }),
      ),
    );

    const result = await scanVisibleTradesInHttpSession(db, session, createDefaultSettings());
    const trade = findTradeById(db, "1003");

    assert.equal(result.manualReviewCount, 1);
    assert.equal(result.pagesCheckedCount, 0);
    assert.equal(result.ranksCheckedCount, 0);
    assert.equal(session.bytesUrls.length, 0);
    assert.equal(trade?.status, "требует_ручной_проверки");
    assert.match(trade?.reason ?? "", /больше одной карты: 2/);
  });
});

test("wanted-pages rule drops a non-passing exchange in non-safe mode without rank checks", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const settings = createDefaultSettings();

    settings.safeMode = false;
    settings.autoAcceptEnabled = false;
    settings.maxWantedPagesExclusive = 5;

    insertNewTrade(db, "1004", "https://mangabuff.ru/trades/1004");
    markTradeTelegramSent(db, "1004");

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1004"])));
    session.queueText(
      "https://mangabuff.ru/trades/1004",
      htmlResponse("https://mangabuff.ru/trades/1004", activeTradeHtml({ tradeId: "1004" })),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(5)),
    );

    const result = await scanVisibleTradesInHttpSession(db, session, settings);
    const trade = findTradeById(db, "1004");

    assert.equal(result.rulesDroppedCount, 1);
    assert.equal(result.pagesCheckedCount, 1);
    assert.equal(result.ranksCheckedCount, 0);
    assert.equal(session.bytesUrls.length, 0);
    assert.equal(trade?.status, "брошен_по_правилам");
    assert.match(trade?.reason ?? "", /Правило требует меньше 5/);
  });
});

test("HTTP scan rechecks visible final records saved with legacy owners URL", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();
    const requestedImage = await createRankImage(0.56, 0.8, 0.3);
    const offeredImage = await createRankImage(0.09, 0.8, 0.35);

    insertNewTrade(db, "1006", "https://mangabuff.ru/trades/1006");
    db.prepare(
      `UPDATE trades
       SET status = 'брошен_по_правилам',
           reason = 'Старое решение по странице владельцев.',
           requested_cards_json = ?,
           offered_cards_json = ?,
           wanted_pages_count = 18
       WHERE trade_id = '1006'`,
    ).run(
      JSON.stringify([{ cardId: "201", url: "https://mangabuff.ru/cards/201/users", title: "Requested D" }]),
      JSON.stringify([{ cardId: "301", url: "https://mangabuff.ru/cards/301/users", title: "Offered C" }]),
    );

    session.queueText(tradesUrl, htmlResponse(tradesUrl, tradesListHtml(["1006"])));
    session.queueText(
      "https://mangabuff.ru/trades/1006",
      htmlResponse("https://mangabuff.ru/trades/1006", activeTradeHtml({ tradeId: "1006" })),
    );
    session.queueText(
      "https://mangabuff.ru/cards/201/offers/want",
      htmlResponse("https://mangabuff.ru/cards/201/offers/want", wantedUsersHtml(1)),
    );
    session.setBytes("https://mangabuff.ru/img/cards/requested-d.png", requestedImage);
    session.setBytes("https://mangabuff.ru/img/cards/offered-c.png", offeredImage);

    const result = await scanVisibleTradesInHttpSession(db, session, createDefaultSettings());
    const trade = findTradeById(db, "1006");

    assert.equal(result.processedCount, 1);
    assert.equal(result.safeAcceptCount, 1);
    assert.equal(trade?.status, "бот_бы_принял");
    assert.equal(trade?.wantedPagesCount, 1);
    assert.equal(trade?.requestedCards[0]?.url, "https://mangabuff.ru/cards/201/offers/want");
    assert.ok(!session.textUrls.includes("https://mangabuff.ru/cards/201/users"));
  });
});

test("technical parsing errors retry once and then become manual review", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();

    insertNewTrade(db, "1005", "https://mangabuff.ru/trades/1005");
    markTradeTelegramSent(db, "1005");

    session.queueText(
      tradesUrl,
      htmlResponse(tradesUrl, tradesListHtml(["1005"])),
      htmlResponse(tradesUrl, tradesListHtml(["1005"])),
    );
    session.queueText(
      "https://mangabuff.ru/trades/1005",
      htmlResponse("https://mangabuff.ru/trades/1005", "<html><body>Предложение обмена без блока trade</body></html>"),
      htmlResponse("https://mangabuff.ru/trades/1005", "<html><body>Предложение обмена без блока trade</body></html>"),
    );

    const first = await scanVisibleTradesInHttpSession(db, session, createDefaultSettings());
    const afterFirst = findTradeById(db, "1005");
    const second = await scanVisibleTradesInHttpSession(db, session, createDefaultSettings());
    const afterSecond = findTradeById(db, "1005");

    assert.equal(first.checkErrorCount, 1);
    assert.equal(afterFirst?.status, "ошибка_проверки");
    assert.equal(afterFirst?.checkAttempts, 1);
    assert.equal(second.manualReviewCount, 1);
    assert.equal(afterSecond?.status, "требует_ручной_проверки");
    assert.equal(afterSecond?.checkAttempts, 2);
    assert.match(afterSecond?.reason ?? "", /Повторная проверка тоже не удалась/);
  });
});

test("missing visible trades mark only new and check-error records as stale", async () => {
  await withDatabase(async (db) => {
    insertNewTrade(db, "new-trade", "https://mangabuff.ru/trades/new-trade");
    insertNewTrade(db, "error-trade", "https://mangabuff.ru/trades/error-trade");
    insertNewTrade(db, "accepted-trade", "https://mangabuff.ru/trades/accepted-trade");
    insertNewTrade(db, "manual-trade", "https://mangabuff.ru/trades/manual-trade");
    recordTradeCheckFailure(db, "error-trade", "Временная ошибка.");
    updateTradeStatus(db, "accepted-trade", "принят", "Принят ранее.");
    updateTradeStatus(db, "manual-trade", "требует_ручной_проверки", "Финальный статус.");

    const staleCount = markMissingTradesAsStale(db, []);

    assert.equal(staleCount, 2);
    assert.equal(findTradeById(db, "new-trade")?.status, "неактуален");
    assert.equal(findTradeById(db, "error-trade")?.status, "неактуален");
    assert.equal(findTradeById(db, "accepted-trade")?.status, "принят");
    assert.equal(findTradeById(db, "manual-trade")?.status, "требует_ручной_проверки");
  });
});

test("HTTP scan treats Mangabuff 505 as a temporary pass failure", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();

    session.queueText(tradesUrl, htmlResponse(tradesUrl, "<html><body>505</body></html>", 505, false));

    await assert.rejects(
      () => scanVisibleTradesInHttpSession(db, session, createDefaultSettings()),
      /ошибку 505/,
    );
  });
});

test("HTTP scan stops on expired Mangabuff authorization", async () => {
  await withDatabase(async (db) => {
    const session = new FakeHttpSession();

    session.queueText(
      tradesUrl,
      htmlResponse("https://mangabuff.ru/login", "<html><body>Войти Авторизация</body></html>"),
    );

    await assert.rejects(
      () => scanVisibleTradesInHttpSession(db, session, createDefaultSettings()),
      /Нужна авторизация Mangabuff/,
    );
  });
});

class FakeHttpSession implements MangabuffSessionClient {
  readonly textUrls: string[] = [];
  readonly bytesUrls: string[] = [];
  readonly posts: Array<{
    url: string;
    data: unknown;
    options: { csrfToken?: string; referer?: string; timeoutMs?: number };
  }> = [];

  private readonly textResponses = new Map<string, MangabuffTextResponse[]>();
  private readonly bytesResponses = new Map<string, Uint8Array>();

  queueText(url: string, ...responses: MangabuffTextResponse[]): void {
    this.textResponses.set(normalizeUrl(url), responses);
  }

  setBytes(url: string, bytes: Uint8Array): void {
    this.bytesResponses.set(normalizeUrl(url), bytes);
  }

  async getText(url: string): Promise<MangabuffTextResponse> {
    this.textUrls.push(normalizeUrl(url));
    const responses = this.textResponses.get(normalizeUrl(url));

    if (!responses || responses.length === 0) {
      throw new Error(`Unexpected HTTP text request: ${url}`);
    }

    if (responses.length === 1) {
      return responses[0];
    }

    return responses.shift()!;
  }

  async getBytes(url: string): Promise<MangabuffBytesResponse> {
    this.bytesUrls.push(normalizeUrl(url));
    const bytes = this.bytesResponses.get(normalizeUrl(url));

    if (!bytes) {
      throw new Error(`Unexpected HTTP bytes request: ${url}`);
    }

    return {
      bytes,
      ok: true,
      status: 200,
      url: normalizeUrl(url),
    };
  }

  async postJson(
    url: string,
    data: unknown,
    options: { csrfToken?: string; referer?: string; timeoutMs?: number } = {},
  ): Promise<MangabuffJsonResponse> {
    this.posts.push({ url: normalizeUrl(url), data, options });

    return {
      json: { ok: true },
      ok: true,
      status: 200,
      text: '{"ok":true}',
      url: normalizeUrl(url),
    };
  }
}

async function withDatabase(callback: (db: AppDatabase) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "baryga-manga-test-"));
  const db = openDatabase(join(directory, "test.sqlite"));

  try {
    await callback(db);
  } finally {
    db.close();
    await rm(directory, { force: true, recursive: true });
  }
}

function htmlResponse(url: string, text: string, status = 200, ok = true): MangabuffTextResponse {
  return {
    ok,
    status,
    text,
    url: normalizeUrl(url),
  };
}

function tradesListHtml(tradeIds: string[]): string {
  return `
    <html>
      <body>
        <nav>Предложения Отправленные</nav>
        ${tradeIds.map((tradeId) => `<a href="/trades/${tradeId}">Предложение обмена</a>`).join("\n")}
      </body>
    </html>
  `;
}

function activeTradeHtml(options: {
  csrfToken?: string;
  offeredCards?: TestCard[];
  requestedCards?: TestCard[];
  tradeId: string;
}): string {
  const requestedCards = options.requestedCards ?? [
    { id: "201", image: "/img/cards/requested-d.png", title: "Requested D" },
  ];
  const offeredCards = options.offeredCards ?? [
    { id: "301", image: "/img/cards/offered-c.png", title: "Offered C" },
  ];

  return `
    <html>
      <head><meta name="csrf-token" content="${options.csrfToken ?? `csrf-${options.tradeId}`}"></head>
      <body>
        <div class="trade">
          <div class="trade__header">
            <a class="trade__header-name" href="/users/42">Трейдер</a> предлагает обмен
          </div>
          <div class="trade__main-items--creator">
            ${offeredCards.map(cardLinkHtml).join("\n")}
          </div>
          <div class="trade__main-items--receiver">
            ${requestedCards.map(cardLinkHtml).join("\n")}
          </div>
          <button class="button trade__accepted-btn">Принять обмен</button>
        </div>
      </body>
    </html>
  `;
}

function wantedUsersHtml(pagesCount: number): string {
  if (pagesCount <= 0) {
    return "<html><body>Никто не хочет получить</body></html>";
  }

  const pagination = Array.from({ length: pagesCount }, (_, index) => {
    const page = index + 1;
    return `<a href="/cards/201/offers/want?page=${page}">${page}</a>`;
  }).join("\n");

  return `
    <html>
      <body>
        <div class="card-show__owner"><a href="/users/1">User</a></div>
        <nav class="pagination">${pagination}</nav>
      </body>
    </html>
  `;
}

function wantedUsersHtmlWithLinks(links: string[]): string {
  return `
    <html>
      <body>
        <div class="profile__friends-item"><a href="/users/1">User</a></div>
        <ul class="pagination">
          <li class="pagination__button pagination__button--active"><a href="#">1</a></li>
          ${links.map((link) => `<li class="pagination__button"><a href="${link}">page</a></li>`).join("\n")}
        </ul>
      </body>
    </html>
  `;
}

function ownersHtml(pagesCount: number): string {
  const pagination = Array.from({ length: pagesCount }, (_, index) => {
    const page = index + 1;
    return `<a href="/cards/201/users?page=${page}">${page}</a>`;
  }).join("\n");

  return `
    <html>
      <body>
        <h1>Пользователи с картой</h1>
        <div class="card-show__owner"><a href="/users/1">Owner</a></div>
        <nav class="pagination">${pagination}</nav>
      </body>
    </html>
  `;
}

function cardLinkHtml(card: TestCard): string {
  return `<a href="${card.href ?? `/cards/${card.id}`}"><img src="${card.image}" alt="${card.title}"></a>`;
}

async function createRankImage(hue: number, saturation: number, lightness: number): Promise<Uint8Array> {
  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  const buffer = await sharp({
    create: {
      background: { alpha: 1, b: blue, g: green, r: red },
      channels: 4,
      height: 100,
      width: 100,
    },
  })
    .png()
    .toBuffer();

  return new Uint8Array(buffer);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue * 6;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const offset = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment < 1) {
    red = chroma;
    green = secondary;
  } else if (segment < 2) {
    red = secondary;
    green = chroma;
  } else if (segment < 3) {
    green = chroma;
    blue = secondary;
  } else if (segment < 4) {
    green = secondary;
    blue = chroma;
  } else if (segment < 5) {
    red = secondary;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondary;
  }

  return [
    Math.round((red + offset) * 255),
    Math.round((green + offset) * 255),
    Math.round((blue + offset) * 255),
  ];
}

function normalizeUrl(url: string): string {
  return new URL(url, "https://mangabuff.ru").href;
}

function readFunctionBlock(source: string, functionName: string): string {
  const start = source.indexOf(`export async function ${functionName}`);

  assert.notEqual(start, -1, `Function ${functionName} was not found`);

  const signatureEnd = source.indexOf("):", start);
  const bodyStart = source.indexOf("{", signatureEnd);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") {
      depth += 1;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Function ${functionName} block was not closed`);
}

interface TestCard {
  href?: string;
  id: string;
  image: string;
  title: string;
}
