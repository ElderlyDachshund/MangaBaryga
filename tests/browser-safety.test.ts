import assert from "node:assert/strict";
import test from "node:test";
import {
  addPositiveJitterMs,
  addSymmetricJitterMs,
  clickVerified,
  detectMangabuffInterruption,
  pickHumanClickPosition,
  waitForMangabuffCaptchaToClear,
} from "../src/browser-safety.js";

test("detectMangabuffInterruption recognizes protection pages", () => {
  assert.equal(
    detectMangabuffInterruption({
      bodyText: "Подтвердите, что вы не робот",
      url: "https://mangabuff.ru/trades",
    }),
    "captcha",
  );
  assert.equal(
    detectMangabuffInterruption({
      bodyText: "Checking your browser before accessing the site — DDoS-Guard",
    }),
    "security_challenge",
  );
  assert.equal(
    detectMangabuffInterruption({
      bodyText: "Too Many Requests",
      status: 429,
    }),
    "rate_limited",
  );
  assert.equal(
    detectMangabuffInterruption({
      bodyText: "Доступ запрещен",
      status: 403,
    }),
    "access_denied",
  );
  assert.equal(
    detectMangabuffInterruption({
      bodyText: "Подтвердите, что вы не робот",
      captchaSolved: true,
      captchaVisible: true,
    }),
    undefined,
  );
});

test("detectMangabuffInterruption leaves ordinary pages alone", () => {
  assert.equal(
    detectMangabuffInterruption({
      bodyText: "Предложения Отправленные",
      status: 200,
      url: "https://mangabuff.ru/trades",
    }),
    undefined,
  );
});

test("addPositiveJitterMs only increases a delay within its configured bound", () => {
  assert.equal(addPositiveJitterMs(10_000, 0.2, 0), 10_000);
  assert.equal(addPositiveJitterMs(10_000, 0.2, 0.5), 11_000);
  assert.equal(addPositiveJitterMs(10_000, 0.2, 1), 12_000);
  assert.equal(addPositiveJitterMs(10_000, 0.2, 2), 12_000);
});

test("addSymmetricJitterMs varies a delay by up to 25 percent", () => {
  assert.equal(addSymmetricJitterMs(3 * 60_000, 0.25, 0), 2 * 60_000 + 15_000);
  assert.equal(addSymmetricJitterMs(3 * 60_000, 0.25, 0.5), 3 * 60_000);
  assert.equal(addSymmetricJitterMs(3 * 60_000, 0.25, 1), 3 * 60_000 + 45_000);
  assert.equal(addSymmetricJitterMs(10 * 60_000, 0.25, 0), 7 * 60_000 + 30_000);
  assert.equal(addSymmetricJitterMs(20 * 60_000, 0.25, 1), 25 * 60_000);
});

test("clickVerified can leave navigation waiting to the caller", async () => {
  const clickOptions: Record<string, unknown>[] = [];
  const locator = {
    click: async (options: Record<string, unknown>) => {
      clickOptions.push(options);
    },
    isEnabled: async () => true,
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => undefined,
  };

  await clickVerified(locator as never, "ссылка", {
    humanize: false,
    noWaitAfter: true,
    timeout: 3_000,
  });

  assert.deepEqual(clickOptions, [
    { timeout: 3_000, trial: true },
    { noWaitAfter: true, timeout: 3_000 },
  ]);
});

test("clickVerified aims at a different spot inside the target on every click", async () => {
  const box = { height: 40, width: 200, x: 100, y: 300 };
  const mouseMoves: { steps?: number; x: number; y: number }[] = [];
  const clickOptions: Record<string, unknown>[] = [];
  const locator = {
    boundingBox: async () => box,
    click: async (options: Record<string, unknown>) => {
      clickOptions.push(options);
    },
    isEnabled: async () => true,
    isVisible: async () => true,
    page: () => ({
      mouse: {
        move: async (x: number, y: number, options?: { steps?: number }) => {
          mouseMoves.push({ steps: options?.steps, x, y });
        },
      },
    }),
    scrollIntoViewIfNeeded: async () => undefined,
  };

  const positions: { x: number; y: number }[] = [];

  for (let attempt = 0; attempt < 12; attempt += 1) {
    clickOptions.length = 0;
    await clickVerified(locator as never, "кнопка");

    const position = clickOptions.at(-1)?.position as { x: number; y: number };
    positions.push(position);

    assert.equal(clickOptions[0].trial, true);
    assert.ok(position.x > 0 && position.x < box.width, "клик должен попадать внутрь элемента");
    assert.ok(position.y > 0 && position.y < box.height, "клик должен попадать внутрь элемента");
    assert.ok(typeof clickOptions.at(-1)?.delay === "number", "нажатие должно иметь длительность");
  }

  const uniquePositions = new Set(positions.map((position) => `${position.x}:${position.y}`));
  assert.ok(uniquePositions.size > 1, "позиция клика не должна быть одинаковой каждый раз");
  assert.equal(mouseMoves.length, positions.length);
  assert.ok(mouseMoves.every((move) => move.x >= box.x && move.x <= box.x + box.width));
  assert.ok(mouseMoves.every((move) => move.y >= box.y && move.y <= box.y + box.height));
});

test("clickVerified falls back to the exact center when the random point is covered", async () => {
  const clickOptions: Record<string, unknown>[] = [];
  const locator = {
    boundingBox: async () => ({ height: 40, width: 200, x: 0, y: 0 }),
    click: async (options: Record<string, unknown>) => {
      clickOptions.push(options);

      if (options.trial === true && options.position) {
        throw new Error("element intercepts pointer events");
      }
    },
    isEnabled: async () => true,
    isVisible: async () => true,
    page: () => ({ mouse: { move: async () => undefined } }),
    scrollIntoViewIfNeeded: async () => undefined,
  };

  await clickVerified(locator as never, "кнопка", { timeout: 3_000 });

  assert.equal(clickOptions.length, 3);
  assert.deepEqual(clickOptions[1], { timeout: 3_000, trial: true });
  assert.deepEqual(clickOptions[2], { noWaitAfter: undefined, timeout: 3_000 });
});

test("pickHumanClickPosition stays inside the central band of the element", () => {
  assert.deepEqual(pickHumanClickPosition(200, 40, 0, 0), { x: 40, y: 8 });
  assert.deepEqual(pickHumanClickPosition(200, 40, 0.5, 0.5), { x: 100, y: 20 });
  assert.deepEqual(pickHumanClickPosition(200, 40, 1, 1), { x: 160, y: 32 });
  assert.deepEqual(pickHumanClickPosition(1, 1, 0, 0), { x: 0.2, y: 0.2 });
  assert.deepEqual(pickHumanClickPosition(1, 1, 1, 1), { x: 0.8, y: 0.8 });
  assert.equal(pickHumanClickPosition(0, 40), undefined);
  assert.equal(pickHumanClickPosition(Number.NaN, 40), undefined);
});

test("waitForMangabuffCaptchaToClear accepts a solved token while the widget stays visible", async () => {
  const captchaSolutions = [false, false, true];
  let visibilityChecks = 0;
  let solutionChecks = 0;
  const page = {
    locator: (selector: string) => {
      if (selector === "body") {
        return {
          innerText: async () => "Предложения",
        };
      }

      return {
        evaluateAll: async () => {
          solutionChecks += 1;
          return captchaSolutions.shift() ?? true;
        },
        first: () => ({
          isVisible: async () => {
            visibilityChecks += 1;
            return true;
          },
        }),
      };
    },
    url: () => "https://mangabuff.ru/trades",
  };

  const cleared = await waitForMangabuffCaptchaToClear(page as never, {
    pollIntervalMs: 0,
  });

  assert.equal(cleared, true);
  assert.equal(visibilityChecks, 3);
  assert.equal(solutionChecks, 3);
});

test("waitForMangabuffCaptchaToClear exits when the bot is stopped", async () => {
  const controller = new AbortController();
  controller.abort();
  let locatorCalls = 0;
  const page = {
    locator: () => {
      locatorCalls += 1;
      throw new Error("page should not be inspected after cancellation");
    },
    url: () => "https://mangabuff.ru/trades",
  };

  const cleared = await waitForMangabuffCaptchaToClear(page as never, {
    pollIntervalMs: 0,
    signal: controller.signal,
  });

  assert.equal(cleared, false);
  assert.equal(locatorCalls, 0);
});

test("waitForMangabuffCaptchaToClear does not wait through a different protection response", async () => {
  const page = {
    locator: (selector: string) => {
      if (selector === "body") {
        return {
          innerText: async () => "Доступ запрещен",
        };
      }

      return {
        evaluateAll: async () => false,
        first: () => ({
          isVisible: async () => false,
        }),
      };
    },
    url: () => "https://mangabuff.ru/trades",
  };

  const cleared = await waitForMangabuffCaptchaToClear(page as never, {
    pollIntervalMs: 0,
  });

  assert.equal(cleared, false);
});
