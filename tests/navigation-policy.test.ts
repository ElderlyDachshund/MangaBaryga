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

test("navigation policy keeps a minimum gap even when the window budget is free", () => {
  const spacedLimits: NavigationLimits = { minGapMs: 800, perHour: 80, perMinute: 8 };
  const now = 1_000_000;

  // Budget is untouched, so only the gap since the previous navigation can delay us.
  assert.equal(calculateNavigationWaitMs([now - 300], now, spacedLimits), 500);
  assert.equal(calculateNavigationWaitMs([now - 800], now, spacedLimits), 0);
  assert.equal(calculateNavigationWaitMs([], now, spacedLimits), 0);
});

test("navigation policy without a configured gap keeps the previous burst behaviour", () => {
  const now = 1_000_000;

  assert.equal(calculateNavigationWaitMs([now - 1], now, limits), 0);
});

test("navigation limiter spaces out a burst that fits inside the minute budget", async () => {
  let now = 10_000;
  const waits: number[] = [];
  const limiter = new MangabuffNavigationLimiter(
    { minGapMs: 800, perHour: 100, perMinute: 50 },
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );

  await limiter.acquire();
  await limiter.acquire();
  await limiter.acquire();

  // The budget alone would let all three through instantly; the gap must not.
  assert.deepEqual(waits, [800, 800]);
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
  // Mangabuff sends no Retry-After and recovers in ~5 seconds, so the default that
  // actually applies to every 429 is a short pause rather than a full minute.
  assert.equal(calculateNavigationBackoffMs(429, undefined), 10_000);
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
