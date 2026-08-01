import assert from "node:assert/strict";
import test from "node:test";
import { goBackToOffersIndex, goBackToTradePage } from "../src/trades.js";

test("the worker walks browser history back to the offers index", async () => {
  const history = [
    "https://mangabuff.ru/trades",
    "https://mangabuff.ru/trades/1001",
    "https://mangabuff.ru/cards/201",
    "https://mangabuff.ru/cards/201/users",
  ];
  const page = createFakePage(history);

  assert.equal(await goBackToOffersIndex(page.page as never), true);
  assert.equal(page.currentUrl(), "https://mangabuff.ru/trades");
  assert.equal(page.backCalls, 3);
});

test("an exhausted history sends the worker back through the visible tab link", async () => {
  const page = createFakePage(["https://mangabuff.ru/cards/201"]);

  assert.equal(await goBackToOffersIndex(page.page as never), false);
  assert.equal(page.backCalls, 1);
});

test("a restored index without trade links is not trusted", async () => {
  const page = createFakePage(
    ["https://mangabuff.ru/trades", "https://mangabuff.ru/trades/1001"],
    { hasTradeLinks: false },
  );

  assert.equal(await goBackToOffersIndex(page.page as never), false);
});

test("acceptance steps back to the trade page instead of reloading it", async () => {
  const page = createFakePage([
    "https://mangabuff.ru/trades",
    "https://mangabuff.ru/trades/1001",
    "https://mangabuff.ru/cards/201",
    "https://mangabuff.ru/cards/201/users",
  ]);

  assert.equal(
    await goBackToTradePage(page.page as never, "https://mangabuff.ru/trades/1001"),
    true,
  );
  assert.equal(page.currentUrl(), "https://mangabuff.ru/trades/1001");
  assert.equal(page.backCalls, 2);
});

test("a trade page missing from history is left to a direct load", async () => {
  const page = createFakePage(["https://mangabuff.ru/trades", "https://mangabuff.ru/cards/201"]);

  assert.equal(
    await goBackToTradePage(page.page as never, "https://mangabuff.ru/trades/1001"),
    false,
  );
});

function createFakePage(history: string[], options: { hasTradeLinks?: boolean } = {}) {
  const stack = [...history];
  const state = {
    backCalls: 0,
    currentUrl: () => stack[stack.length - 1],
    page: {
      goBack: async () => {
        state.backCalls += 1;

        if (stack.length > 1) {
          stack.pop();
        }

        return null;
      },
      locator: (selector: string) => {
        if (selector === "body") {
          return { innerText: async () => "Предложения Отправленные" };
        }

        return {
          evaluateAll: async () => false,
          first: () => ({
            isVisible: async () =>
              selector.startsWith('a[href^="/trades/"]')
                ? options.hasTradeLinks !== false
                : selector === ".trade",
          }),
        };
      },
      url: () => stack[stack.length - 1],
      waitForTimeout: async () => undefined,
    },
  };

  return state;
}
