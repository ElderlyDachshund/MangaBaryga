import assert from "node:assert/strict";
import test from "node:test";
import { formatCaptchaNotification } from "../src/telegram.js";

test("CAPTCHA detected notification explains that the bot is waiting without clicking", () => {
  const message = formatCaptchaNotification(
    "detected",
    "https://mangabuff.ru/trades",
  );

  assert.match(message, /запросил CAPTCHA/);
  assert.match(message, /ничего не нажимает/);
  assert.match(message, /подтверди её вручную/);
  assert.match(message, /https:\/\/mangabuff\.ru\/trades/);
});

test("CAPTCHA cleared notification confirms that the same session continues", () => {
  const message = formatCaptchaNotification("cleared");

  assert.match(message, /CAPTCHA Mangabuff пройдена/);
  assert.match(message, /той же браузерной сессии/);
});

test("CAPTCHA test notification cannot be mistaken for a real alert", () => {
  const message = formatCaptchaNotification("test");

  assert.match(message, /Тест уведомлений CAPTCHA/);
  assert.doesNotMatch(message, /запросил CAPTCHA/);
});
