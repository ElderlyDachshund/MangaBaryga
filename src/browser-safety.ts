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
    input.captchaVisible ||
    url.includes("captcha") ||
    containsAny(bodyText, [
      "captcha",
      "подтвердите, что вы не робот",
      "подтвердите что вы не робот",
      "я не робот",
    ])
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
  const [bodyText, captchaVisible] = await Promise.all([
    page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    page
      .locator(
        'iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], textarea[name="g-recaptcha-response"]',
      )
      .first()
      .isVisible()
      .catch(() => false),
  ]);
  const interruption = detectMangabuffInterruption({
    bodyText,
    captchaVisible,
    status,
    url: page.url(),
  });

  if (!interruption) {
    return;
  }

  throw new MangabuffInteractionBlockedError(
    interruption,
    interruptionMessage(interruption),
  );
}

export async function clickVerified(
  locator: Locator,
  label: string,
  timeout = 5_000,
): Promise<void> {
  if (!(await locator.isVisible({ timeout }).catch(() => false))) {
    throw new Error(`Не найден доступный элемент для действия: ${label}.`);
  }

  if (!(await locator.isEnabled({ timeout }).catch(() => false))) {
    throw new Error(`Элемент недоступен для действия: ${label}.`);
  }

  await locator.scrollIntoViewIfNeeded({ timeout });
  await locator.click({ timeout, trial: true });
  await locator.click({ timeout });
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
