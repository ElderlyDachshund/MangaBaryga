import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMangabuffPassword,
  readMangabuffCredentials,
} from "../src/credentials.js";

test("Mangabuff credentials preserve significant password whitespace", () => {
  const credentials = readMangabuffCredentials({
    MANGABUFF_LOGIN: "  user@example.com  ",
    MANGABUFF_PASSWORD: "secret ",
  });

  assert.deepEqual(credentials, {
    login: "user@example.com",
    password: "secret ",
  });
});

test("Mangabuff credentials reject a missing or empty password", () => {
  assert.equal(readMangabuffCredentials({ MANGABUFF_LOGIN: "user@example.com" }), undefined);
  assert.equal(
    readMangabuffCredentials({
      MANGABUFF_LOGIN: "user@example.com",
      MANGABUFF_PASSWORD: "",
    }),
    undefined,
  );
  assert.equal(hasMangabuffPassword({ MANGABUFF_PASSWORD: "" }), false);
  assert.equal(hasMangabuffPassword({ MANGABUFF_PASSWORD: " " }), true);
});
