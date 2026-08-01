import assert from "node:assert/strict";
import { chromium } from "playwright";
import { waitForMangabuffCaptchaToClear } from "../src/browser-safety.js";

const browser = await chromium.launch({
  executablePath: chromium.executablePath(),
  headless: process.env.CAPTCHA_TEST_HEADLESS === "1",
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.setContent(`
    <!doctype html>
    <html lang="ru">
      <body>
        <main>
          <p>Подтвердите, что вы не робот</p>
          <div class="captcha-widget">Я не робот</div>
          <textarea name="g-recaptcha-response" hidden></textarea>
        </main>
      </body>
    </html>
  `);

  await page.evaluate(() => {
    const testWindow = window as typeof window & { captchaTestClicks?: number };
    testWindow.captchaTestClicks = 0;
    document.addEventListener("click", () => {
      testWindow.captchaTestClicks = (testWindow.captchaTestClicks ?? 0) + 1;
    });

    setTimeout(() => {
      const response = document.querySelector<HTMLTextAreaElement>(
        'textarea[name="g-recaptcha-response"]',
      );

      if (response) {
        response.value = "local-test-token";
        response.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, 750);
  });

  const originalPage = page;
  const cleared = await waitForMangabuffCaptchaToClear(page, {
    pollIntervalMs: 100,
  });
  const clickCount = await page.evaluate(
    () => (window as typeof window & { captchaTestClicks?: number }).captchaTestClicks ?? 0,
  );

  assert.equal(cleared, true, "CAPTCHA wait did not resume after the response token appeared");
  assert.equal(clickCount, 0, "CAPTCHA wait generated a browser click");
  assert.equal(context.pages().length, 1, "CAPTCHA wait opened or replaced a browser page");
  assert.equal(context.pages()[0], originalPage, "CAPTCHA wait did not preserve the original page");

  await originalPage.setContent("<main>Работа продолжена в той же вкладке</main>");
  assert.match(await originalPage.locator("main").innerText(), /Работа продолжена/);

  console.log(
    "OK: headful Chromium дождался CAPTCHA-token без кликов и продолжил в той же вкладке/context.",
  );
} finally {
  await browser.close();
}
