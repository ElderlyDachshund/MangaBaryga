import assert from "node:assert/strict";
import test from "node:test";
import {
  addPositiveJitterMs,
  detectMangabuffInterruption,
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
