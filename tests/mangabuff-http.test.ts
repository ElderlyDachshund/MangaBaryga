import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithConnectionRetry, isConnectionError } from "../src/mangabuff-http.js";

const requestOptions = {
  headers: { accept: "text/html" },
  method: "GET",
  redirect: "follow" as RequestRedirect,
  timeoutMs: 5_000,
};

test("connection errors are told apart from real HTTP answers", () => {
  assert.equal(isConnectionError(new TypeError("fetch failed")), true);
  assert.equal(isConnectionError(new Error("ECONNRESET")), true);
  assert.equal(isConnectionError(Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  })), true);

  assert.equal(isConnectionError(new Error("Too Many Requests")), false);
  assert.equal(isConnectionError("fetch failed"), false);
});

test("a dropped connection is retried and the later attempt is returned", async () => {
  const attempts: number[] = [];
  const response = await fetchWithConnectionRetry(
    "https://mangabuff.ru/trades",
    requestOptions,
    3,
    0,
    async () => {
      attempts.push(attempts.length + 1);

      if (attempts.length < 3) {
        throw new TypeError("fetch failed");
      }

      return new Response("ok", { status: 200 });
    },
  );

  assert.equal(attempts.length, 3);
  assert.equal(response.status, 200);
});

test("a real HTTP answer is never retried", async () => {
  let calls = 0;
  const response = await fetchWithConnectionRetry(
    "https://mangabuff.ru/trades",
    requestOptions,
    3,
    0,
    async () => {
      calls += 1;
      return new Response("slow down", { status: 429 });
    },
  );

  assert.equal(calls, 1);
  assert.equal(response.status, 429);
});

test("an error that is not a dropped connection fails immediately", async () => {
  let calls = 0;

  await assert.rejects(
    fetchWithConnectionRetry("https://mangabuff.ru/trades", requestOptions, 3, 0, async () => {
      calls += 1;
      throw new Error("Нужна авторизация Mangabuff.");
    }),
    /Нужна авторизация/,
  );

  assert.equal(calls, 1);
});

test("the last dropped connection is surfaced once the attempts run out", async () => {
  let calls = 0;

  await assert.rejects(
    fetchWithConnectionRetry("https://mangabuff.ru/trades", requestOptions, 2, 0, async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }),
    /fetch failed/,
  );

  assert.equal(calls, 2);
});
