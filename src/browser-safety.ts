import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";

export type MangabuffInterruption =
  | "access_denied"
  | "captcha"
  | "rate_limited"
  | "security_challenge";

export class MangabuffInteractionBlockedError extends Error {
  constructor(
    public readonly interruption: MangabuffInterruption,
    message: string,
  ) {
    super(message);
    this.name = "MangabuffInteractionBlockedError";
  }
}

export function detectMangabuffInterruption(input: {
  bodyText: string;
  captchaSolved?: boolean;
  captchaVisible?: boolean;
  status?: number;
  url?: string;
}): MangabuffInterruption | undefined {
  const bodyText = input.bodyText.toLowerCase();
  const url = input.url?.toLowerCase() ?? "";

  if (input.status === 429 || containsAny(bodyText, [
    "too many requests",
    "слишком много запросов",
    "превышен лимит запросов",
  ])) {
    return "rate_limited";
  }

  if (
    !input.captchaSolved &&
    (
      input.captchaVisible ||
      url.includes("captcha") ||
      containsAny(bodyText, [
        "captcha",
        "подтвердите, что вы не робот",
        "подтвердите что вы не робот",
        "я не робот",
      ])
    )
  ) {
    return "captcha";
  }

  if (containsAny(bodyText, [
    "checking your browser",
    "проверяем ваш браузер",
    "проверка браузера",
    "ddos-guard",
  ])) {
    return "security_challenge";
  }

  if (
    input.status === 403 ||
    containsAny(bodyText, [
      "access denied",
      "доступ запрещен",
      "доступ ограничен",
    ])
  ) {
    return "access_denied";
  }

  return undefined;
}

export async function assertMangabuffPageReady(
  page: Page,
  status?: number,
): Promise<void> {
  const interruption = await detectMangabuffPageInterruption(page, status);

  if (!interruption) {
    return;
  }

  throw new MangabuffInteractionBlockedError(
    interruption,
    interruptionMessage(interruption),
  );
}

export async function detectMangabuffPageInterruption(
  page: Page,
  status?: number,
): Promise<MangabuffInterruption | undefined> {
  const [bodyText, captchaVisible, captchaSolved] = await Promise.all([
    page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    page
      .locator(
        'iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], textarea[name="g-recaptcha-response"]',
      )
      .first()
      .isVisible()
      .catch(() => false),
    page
      .locator(
        'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]',
      )
      .evaluateAll((elements) =>
        elements.some((element) => {
          const field = element as HTMLInputElement | HTMLTextAreaElement;
          return typeof field.value === "string" && field.value.trim().length > 0;
        }),
      )
      .catch(() => false),
  ]);

  return detectMangabuffInterruption({
    bodyText,
    captchaSolved,
    captchaVisible,
    status,
    url: page.url(),
  });
}

export async function waitForMangabuffCaptchaToClear(
  page: Page,
  options: {
    pollIntervalMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error("CAPTCHA poll interval must be a non-negative finite number.");
  }

  while (!options.signal?.aborted) {
    const interruption = await detectMangabuffPageInterruption(page);

    if (!interruption) {
      return true;
    }

    if (interruption !== "captcha") {
      return false;
    }

    try {
      await sleep(pollIntervalMs, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal?.aborted) {
        throw error;
      }
    }
  }

  return false;
}

export interface ElementBox {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface ClickPosition {
  x: number;
  y: number;
}

const humanClickInsetFraction = 0.2;
const humanClickPressMinMs = 40;
const humanClickPressMaxMs = 140;
const humanClickHesitationMinMs = 80;
const humanClickHesitationMaxMs = 320;

export async function clickVerified(
  locator: Locator,
  label: string,
  options: {
    humanize?: boolean;
    noWaitAfter?: boolean;
    timeout?: number;
  } = {},
): Promise<void> {
  const timeout = options.timeout ?? 5_000;

  if (!(await locator.isVisible({ timeout }).catch(() => false))) {
    throw new Error(`Не найден доступный элемент для действия: ${label}.`);
  }

  if (!(await locator.isEnabled({ timeout }).catch(() => false))) {
    throw new Error(`Элемент недоступен для действия: ${label}.`);
  }

  await locator.scrollIntoViewIfNeeded({ timeout });

  const humanize = options.humanize !== false;
  const box = humanize ? await readElementBox(locator, timeout) : undefined;
  let position = box ? pickHumanClickPosition(box.width, box.height) : undefined;

  try {
    await locator.click(position ? { position, timeout, trial: true } : { timeout, trial: true });
  } catch (error) {
    if (!position) {
      throw error;
    }

    // The randomized point can land on an overlay; Playwright's own center still works.
    position = undefined;
    await locator.click({ timeout, trial: true });
  }

  if (box && position) {
    await moveMouseToTargetLikeHuman(locator, box, position);
    await sleep(pickHumanClickHesitationMs());
  }

  await locator.click({
    noWaitAfter: options.noWaitAfter,
    timeout,
    ...(position ? { delay: pickHumanClickPressMs(), position } : {}),
  });
}

/**
 * Real users never hit the same pixel twice, so every click lands somewhere inside
 * the central band of the target instead of its geometric center.
 */
export function pickHumanClickPosition(
  width: number,
  height: number,
  randomX = Math.random(),
  randomY = Math.random(),
): ClickPosition | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }

  return {
    x: pickHumanClickOffset(width, randomX),
    y: pickHumanClickOffset(height, randomY),
  };
}

export function pickHumanClickPressMs(randomValue = Math.random()): number {
  return pickInRange(humanClickPressMinMs, humanClickPressMaxMs, randomValue);
}

export function pickHumanClickHesitationMs(randomValue = Math.random()): number {
  return pickInRange(humanClickHesitationMinMs, humanClickHesitationMaxMs, randomValue);
}

/**
 * Best-effort idle activity for a page the bot only keeps open to look like a reader.
 * It scrolls and moves the pointer, and never clicks anything.
 */
export async function performIdlePageActivity(
  page: Page,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const steps = pickInRange(1, 3, Math.random());

  for (let step = 0; step < steps; step += 1) {
    if (options.signal?.aborted) {
      return;
    }

    try {
      const viewport = page.viewportSize();

      if (viewport) {
        await page.mouse.move(
          pickInRange(Math.round(viewport.width * 0.1), Math.round(viewport.width * 0.9), Math.random()),
          pickInRange(Math.round(viewport.height * 0.1), Math.round(viewport.height * 0.9), Math.random()),
          { steps: pickInRange(6, 18, Math.random()) },
        );
      }

      const scrollDown = Math.random() > 0.25;
      await page.mouse.wheel(0, pickInRange(180, 900, Math.random()) * (scrollDown ? 1 : -1));
    } catch {
      // Idle activity is decorative: a closed or navigating page must not break the pass.
      return;
    }

    try {
      await sleep(pickInRange(400, 1_600, Math.random()), undefined, { signal: options.signal });
    } catch {
      return;
    }
  }
}

function pickHumanClickOffset(size: number, randomValue: number): number {
  const normalizedRandom = Math.min(1, Math.max(0, randomValue));
  const inset = size * humanClickInsetFraction;
  const usableSize = size - 2 * inset;

  return Math.round((inset + usableSize * normalizedRandom) * 10) / 10;
}

function pickInRange(min: number, max: number, randomValue: number): number {
  const normalizedRandom = Math.min(1, Math.max(0, randomValue));
  return Math.round(min + (max - min) * normalizedRandom);
}

async function readElementBox(locator: Locator, timeout: number): Promise<ElementBox | undefined> {
  try {
    const box = await locator.boundingBox({ timeout });
    return box ?? undefined;
  } catch {
    return undefined;
  }
}

async function moveMouseToTargetLikeHuman(
  locator: Locator,
  box: ElementBox,
  position: ClickPosition,
): Promise<void> {
  try {
    await locator.page().mouse.move(box.x + position.x, box.y + position.y, {
      steps: pickInRange(6, 18, Math.random()),
    });
  } catch {
    // Pointer movement is cosmetic; the click below still works without it.
  }
}

export function addPositiveJitterMs(
  baseMs: number,
  maxAdditionalFraction = 0.2,
  randomValue = Math.random(),
): number {
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new Error("baseMs must be a non-negative finite number.");
  }

  if (!Number.isFinite(maxAdditionalFraction) || maxAdditionalFraction < 0) {
    throw new Error("maxAdditionalFraction must be a non-negative finite number.");
  }

  const normalizedRandom = Math.min(1, Math.max(0, randomValue));
  return Math.round(baseMs * (1 + maxAdditionalFraction * normalizedRandom));
}

export function addSymmetricJitterMs(
  baseMs: number,
  maxFraction = 0.25,
  randomValue = Math.random(),
): number {
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new Error("baseMs must be a non-negative finite number.");
  }

  if (!Number.isFinite(maxFraction) || maxFraction < 0 || maxFraction > 1) {
    throw new Error("maxFraction must be between 0 and 1.");
  }

  const normalizedRandom = Math.min(1, Math.max(0, randomValue));
  const multiplier = 1 - maxFraction + 2 * maxFraction * normalizedRandom;

  return Math.round(baseMs * multiplier);
}

function containsAny(value: string, fragments: string[]): boolean {
  return fragments.some((fragment) => value.includes(fragment));
}

function interruptionMessage(interruption: MangabuffInterruption): string {
  switch (interruption) {
    case "captcha":
      return "Автоматизация остановлена: Mangabuff запросил CAPTCHA. Нужна ручная проверка.";
    case "rate_limited":
      return "Автоматизация остановлена: Mangabuff сообщил о превышении лимита запросов.";
    case "security_challenge":
      return "Автоматизация остановлена: Mangabuff показал защитную проверку браузера.";
    case "access_denied":
      return "Автоматизация остановлена: Mangabuff ограничил доступ.";
  }
}
