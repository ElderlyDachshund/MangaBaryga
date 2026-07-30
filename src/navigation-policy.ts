import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserContext } from "playwright";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;

export interface NavigationLimits {
  perHour: number;
  perMinute: number;
}

export const defaultNavigationLimits: NavigationLimits = {
  perHour: readIntegerEnv("MANGABUFF_NAVIGATIONS_PER_HOUR", 80, 1, 80),
  perMinute: readIntegerEnv("MANGABUFF_NAVIGATIONS_PER_MINUTE", 8, 1, 8),
};

export function calculateNavigationWaitMs(
  timestamps: number[],
  now: number,
  limits: NavigationLimits = defaultNavigationLimits,
): number {
  const hourEntries = timestamps.filter((timestamp) => timestamp > now - hourMs);
  const minuteEntries = hourEntries.filter((timestamp) => timestamp > now - minuteMs);
  let waitMs = 0;

  if (minuteEntries.length >= limits.perMinute) {
    const blockingTimestamp = minuteEntries[minuteEntries.length - limits.perMinute];
    waitMs = Math.max(waitMs, blockingTimestamp + minuteMs - now + 1);
  }

  if (hourEntries.length >= limits.perHour) {
    const blockingTimestamp = hourEntries[hourEntries.length - limits.perHour];
    waitMs = Math.max(waitMs, blockingTimestamp + hourMs - now + 1);
  }

  return waitMs;
}

export class MangabuffNavigationLimiter {
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private timestamps: number[] = [];

  constructor(
    private readonly limits: NavigationLimits = defaultNavigationLimits,
    private readonly now: () => number = Date.now,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => sleep(milliseconds),
  ) {}

  acquire(countNavigation = true): Promise<void> {
    const task = this.queue.then(() => this.acquireNextSlot(countNavigation));
    this.queue = task.catch(() => {});
    return task;
  }

  penalize(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return;
    }

    this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.ceil(milliseconds));
  }

  private async acquireNextSlot(countNavigation: boolean): Promise<void> {
    while (true) {
      const now = this.now();
      this.timestamps = this.timestamps.filter((timestamp) => timestamp > now - hourMs);
      const rateLimitWaitMs = countNavigation
        ? calculateNavigationWaitMs(this.timestamps, now, this.limits)
        : 0;
      const waitMs = Math.max(rateLimitWaitMs, this.blockedUntil - now);

      if (waitMs === 0) {
        if (countNavigation) {
          this.timestamps.push(now);
        }
        return;
      }

      await this.wait(waitMs);
    }
  }
}

const processNavigationLimiter = new MangabuffNavigationLimiter();

export async function installMangabuffNavigationPolicy(context: BrowserContext): Promise<void> {
  context.on("response", (response) => {
    const request = response.request();

    if (
      request.isNavigationRequest() &&
      response.url().startsWith("https://mangabuff.ru/")
    ) {
      processNavigationLimiter.penalize(
        calculateNavigationBackoffMs(
          response.status(),
          response.headers()["retry-after"],
        ),
      );
    }
  });

  await context.route("https://mangabuff.ru/**", async (route) => {
    const request = route.request();

    if (request.isNavigationRequest()) {
      await processNavigationLimiter.acquire(
        !isOffersIndexRefresh(request.url(), request.frame().url()),
      );
    }

    await route.continue();
  });
}

export function calculateNavigationBackoffMs(
  status: number,
  retryAfter: string | undefined,
  now = Date.now(),
): number {
  if (status === 429) {
    return parseRetryAfterMs(retryAfter, now) ?? 60_000;
  }

  if (status === 502 || status === 503 || status === 504) {
    return parseRetryAfterMs(retryAfter, now) ?? 15_000;
  }

  return 0;
}

function parseRetryAfterMs(value: string | undefined, now: number): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function isOffersIndexRefresh(targetUrl: string, currentFrameUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const current = new URL(currentFrameUrl);

    return (
      target.origin === "https://mangabuff.ru" &&
      target.pathname === "/trades" &&
      target.search === "" &&
      current.origin === target.origin &&
      current.pathname === target.pathname
    );
  } catch {
    return false;
  }
}

function readIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
