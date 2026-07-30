import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNavigationBackoffMs,
  calculateNavigationWaitMs,
  isOffersIndexRefresh,
  MangabuffNavigationLimiter,
  type NavigationLimits,
} from "../src/navigation-policy.js";

const limits: NavigationLimits = {
  perHour: 80,
  perMinute: 8,
};

test("navigation policy allows the eighth navigation in a minute and delays the ninth", () => {
  const now = 1_000_000;
  const sevenRecentNavigations = Array.from({ length: 7 }, (_, index) => now - 7_000 + index * 1_000);
  const eightRecentNavigations = [...sevenRecentNavigations, now - 500];

  assert.equal(calculateNavigationWaitMs(sevenRecentNavigations, now, limits), 0);
  assert.equal(calculateNavigationWaitMs(eightRecentNavigations, now, limits), 53_001);
});

test("navigation policy delays the eighty-first navigation until the hourly window opens", () => {
  const now = 4_000_000;
  const hourlyHistory = Array.from({ length: 80 }, (_, index) => now - 3_500_000 + index * 40_000);

  assert.equal(calculateNavigationWaitMs(hourlyHistory, now, limits), 100_001);
});

test("navigation limiter serializes concurrent callers", async () => {
  let now = 10_000;
  const waits: number[] = [];
  const limiter = new MangabuffNavigationLimiter(
    { perHour: 3, perMinute: 2 },
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );

  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

  assert.deepEqual(waits, [60_001]);
});

test("navigation limiter applies server backoff without charging refreshes to the rate budget", async () => {
  let now = 10_000;
  const waits: number[] = [];
  const limiter = new MangabuffNavigationLimiter(
    { perHour: 1, perMinute: 1 },
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );

  await limiter.acquire();
  limiter.penalize(15_000);
  await limiter.acquire(false);

  assert.deepEqual(waits, [15_000]);
});

test("navigation backoff respects Retry-After and has conservative defaults", () => {
  assert.equal(calculateNavigationBackoffMs(429, "12"), 12_000);
  assert.equal(calculateNavigationBackoffMs(429, undefined), 60_000);
  assert.equal(calculateNavigationBackoffMs(503, undefined), 15_000);
  assert.equal(calculateNavigationBackoffMs(200, "12"), 0);
});

test("offers-index refreshes do not consume the away-navigation budget", () => {
  assert.equal(
    isOffersIndexRefresh("https://mangabuff.ru/trades", "https://mangabuff.ru/trades"),
    true,
  );
  assert.equal(
    isOffersIndexRefresh("https://mangabuff.ru/trades", "https://mangabuff.ru/trades/77617719"),
    false,
  );
  assert.equal(
    isOffersIndexRefresh("https://mangabuff.ru/trades?page=2", "https://mangabuff.ru/trades"),
    false,
  );
});
