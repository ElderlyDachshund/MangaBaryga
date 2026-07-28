import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOwnedCardsPage,
  runCardLockingInHttpSession,
} from "../src/card-locking.js";
import type {
  MangabuffBytesResponse,
  MangabuffJsonResponse,
  MangabuffSessionClient,
  MangabuffTextResponse,
} from "../src/mangabuff-http.js";

test("owned-card parser keeps card IDs, physical instance IDs, and lock state separate", () => {
  const parsed = parseOwnedCardsPage(
    ownedCardsHtml(2, [
      { cardId: "77", instanceId: "1001", locked: false, title: "Открытая карта" },
      { cardId: "77", instanceId: "1002", locked: true, title: "Закрытый дубликат" },
    ]),
  );

  assert.equal(parsed.totalCount, 2);
  assert.equal(parsed.csrfToken, "collection-csrf");
  assert.deepEqual(parsed.instances, [
    { cardId: "77", instanceId: "1001", locked: false, title: "Открытая карта" },
    { cardId: "77", instanceId: "1002", locked: true, title: "Закрытый дубликат" },
  ]);
});

test("recent scan follows sort=new pages until the exact instance limit", async () => {
  const session = new FakeCardSession();
  session.setText("https://mangabuff.ru/", authorizedHomeHtml());
  session.setText(
    "https://mangabuff.ru/users/42/cards?sort=new",
    ownedCardsHtml(4, [
      { cardId: "10", instanceId: "100", locked: false },
      { cardId: "10", instanceId: "101", locked: true },
    ]),
  );
  session.setText(
    "https://mangabuff.ru/users/42/cards?sort=new&page=2",
    ownedCardsHtml(4, [
      { cardId: "20", instanceId: "200", locked: false },
      { cardId: "30", instanceId: "300", locked: false },
    ]),
  );
  session.setText("https://mangabuff.ru/cards/10/offers/want", wantedPagesHtml(5));
  session.setText("https://mangabuff.ru/cards/20/offers/want", wantedPagesHtml(2));

  const result = await runCardLockingInHttpSession(session, {
    mode: "recent",
    threshold: 5,
    recentLimit: 3,
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.totalCount, 3);
  assert.equal(result.checkedCount, 3);
  assert.equal(result.lockedCount, 1);
  assert.equal(result.alreadyLockedCount, 1);
  assert.equal(result.belowThresholdCount, 1);
  assert.equal(result.errorCount, 0);
  assert.ok(session.textUrls.includes("https://mangabuff.ru/users/42/cards?sort=new&page=2"));
  assert.ok(!session.textUrls.includes("https://mangabuff.ru/cards/30/offers/want"));
  assert.deepEqual(session.posts, [
    {
      body: "card_ids%5B%5D=100&is_lock=1",
      csrfToken: "collection-csrf",
      referer: "https://mangabuff.ru/users/42/cards?sort=new",
      url: "https://mangabuff.ru/trades/lockCards",
    },
  ]);
});

test("all-cards scan checks duplicate popularity once and explicitly locks every open instance", async () => {
  const session = new FakeCardSession();
  session.setText("https://mangabuff.ru/", authorizedHomeHtml());
  session.setText(
    "https://mangabuff.ru/users/42/cards",
    ownedCardsHtml(2, [
      { cardId: "10", instanceId: "100", locked: false },
      { cardId: "10", instanceId: "101", locked: false },
    ]),
  );
  session.setText("https://mangabuff.ru/cards/10/offers/want", wantedPagesHtml(7));

  const result = await runCardLockingInHttpSession(session, {
    mode: "all",
    threshold: 5,
  });

  assert.equal(result.checkedCount, 2);
  assert.equal(result.lockedCount, 2);
  assert.equal(
    session.textUrls.filter((url) => url === "https://mangabuff.ru/cards/10/offers/want").length,
    1,
  );
  assert.equal(session.posts[0]?.body, "card_ids%5B%5D=100&card_ids%5B%5D=101&is_lock=1");
  assert.ok(session.posts.every((post) => post.url.endsWith("/trades/lockCards")));
});

test("wanted-page failure is reported and the scan continues with the next card", async () => {
  const session = new FakeCardSession();
  session.setText("https://mangabuff.ru/", authorizedHomeHtml());
  session.setText(
    "https://mangabuff.ru/users/42/cards",
    ownedCardsHtml(2, [
      { cardId: "10", instanceId: "100", locked: false },
      { cardId: "20", instanceId: "200", locked: false },
    ]),
  );
  session.setText("https://mangabuff.ru/cards/10/offers/want", "<html>Error</html>", 500);
  session.setText("https://mangabuff.ru/cards/20/offers/want", wantedPagesHtml(6));

  const result = await runCardLockingInHttpSession(session, {
    mode: "all",
    threshold: 5,
  });

  assert.equal(result.checkedCount, 2);
  assert.equal(result.errorCount, 1);
  assert.equal(result.errors[0]?.cardId, "10");
  assert.equal(result.lockedCount, 1);
  assert.equal(session.posts[0]?.body, "card_ids%5B%5D=200&is_lock=1");
});

test("stop signal cancels the scan without sending a pending lock batch", async () => {
  const session = new FakeCardSession();
  const controller = new AbortController();
  session.setText("https://mangabuff.ru/", authorizedHomeHtml());
  session.setText(
    "https://mangabuff.ru/users/42/cards",
    ownedCardsHtml(2, [
      { cardId: "10", instanceId: "100", locked: false },
      { cardId: "20", instanceId: "200", locked: false },
    ]),
  );
  session.setText("https://mangabuff.ru/cards/10/offers/want", wantedPagesHtml(6));
  session.setText("https://mangabuff.ru/cards/20/offers/want", wantedPagesHtml(6));

  const result = await runCardLockingInHttpSession(session, {
    mode: "all",
    threshold: 5,
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.checkedCount === 1) {
        controller.abort();
      }
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.checkedCount, 1);
  assert.equal(result.lockedCount, 0);
  assert.equal(session.posts.length, 0);
  assert.ok(!session.textUrls.includes("https://mangabuff.ru/cards/20/offers/want"));
});

class FakeCardSession implements MangabuffSessionClient {
  readonly textUrls: string[] = [];
  readonly posts: Array<{
    body: string;
    csrfToken?: string;
    referer?: string;
    url: string;
  }> = [];
  private readonly textResponses = new Map<string, { status: number; text: string }>();

  setText(url: string, text: string, status = 200): void {
    this.textResponses.set(url, { status, text });
  }

  async getText(url: string): Promise<MangabuffTextResponse> {
    this.textUrls.push(url);
    const response = this.textResponses.get(url);

    if (!response) {
      return {
        url,
        status: 404,
        ok: false,
        text: "",
      };
    }

    return {
      url,
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text: response.text,
    };
  }

  async getBytes(url: string): Promise<MangabuffBytesResponse> {
    return {
      url,
      status: 404,
      ok: false,
      bytes: new Uint8Array(),
    };
  }

  async postForm(
    url: string,
    data: unknown,
    options: { csrfToken?: string; referer?: string } = {},
  ): Promise<MangabuffJsonResponse> {
    this.posts.push({
      body: data instanceof URLSearchParams ? data.toString() : "",
      csrfToken: options.csrfToken,
      referer: options.referer,
      url,
    });

    return {
      url,
      status: 200,
      ok: true,
      json: { message: "Карты закрыты" },
      text: '{"message":"Карты закрыты"}',
    };
  }
}

function authorizedHomeHtml(): string {
  return `
    <html>
      <script>
        window.isAuth = 1;
        window.user_id = 42;
      </script>
    </html>
  `;
}

function ownedCardsHtml(
  totalCount: number,
  cards: Array<{ cardId: string; instanceId: string; locked: boolean; title?: string }>,
): string {
  return `
    <html>
      <head><meta name="csrf-token" content="collection-csrf"></head>
      <body>
        <h2>Карточки ${totalCount}</h2>
        ${cards
          .map(
            (card) => `
              <div class="manga-cards__item-wrapper" data-created="2026-07-28 21:31:57">
                <div class="manga-cards__item" data-name="${card.title ?? `Card ${card.cardId}`}" data-card-id="${card.cardId}">
                  <div class="manga-cards__image"></div>
                  <div class="lock-card-btn" data-id="${card.instanceId}">
                    <i class="icon ${card.locked ? "icon-lock" : "icon-unlock"}"></i>
                  </div>
                </div>
              </div>
            `,
          )
          .join("")}
      </body>
    </html>
  `;
}

function wantedPagesHtml(count: number): string {
  return `
    <html>
      <body>
        <div class="card-show__owner"><a href="/users/1">User</a></div>
        ${Array.from({ length: count }, (_, index) => index + 1)
          .map((page) => `<a href="/cards/10/offers/want?page=${page}">${page}</a>`)
          .join("")}
      </body>
    </html>
  `;
}
