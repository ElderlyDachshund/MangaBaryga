import assert from "node:assert/strict";
import test from "node:test";
import {
  selectBackgroundPageIndex,
  selectDueBackgroundPageIndex,
  type BackgroundPageScheduleEntry,
} from "../src/trades.js";

const schedule: BackgroundPageScheduleEntry[] = [
  { intervalMs: 180_000, nextVisitAt: 100, url: "https://mangabuff.ru/feed" },
  { intervalMs: 600_000, nextVisitAt: 200, url: "https://mangabuff.ru/" },
  { intervalMs: 1_200_000, nextVisitAt: 300, url: "https://mangabuff.ru/manga" },
];

test("background visit selection returns no page before anything is due", () => {
  assert.equal(selectDueBackgroundPageIndex(schedule, 99, 0), undefined);
});

test("background visit selection chooses one random due page instead of a fixed sequence", () => {
  assert.equal(selectDueBackgroundPageIndex(schedule, 250, 0), 0);
  assert.equal(selectDueBackgroundPageIndex(schedule, 250, 0.999), 1);
  assert.equal(selectDueBackgroundPageIndex(schedule, 350, 0.5), 1);
  assert.equal(selectDueBackgroundPageIndex(schedule, 350, 1), 2);
});

test("away page selection always leaves the offers index, even before anything is due", () => {
  assert.equal(selectBackgroundPageIndex(schedule, 99, 0), 0);
  assert.equal(selectBackgroundPageIndex(schedule, 99, 1), 0);
  assert.equal(selectBackgroundPageIndex(schedule, 250, 0), 0);
  assert.equal(selectBackgroundPageIndex(schedule, 250, 0.999), 1);
  assert.equal(selectBackgroundPageIndex([], 99, 0), undefined);
});

test("away page selection spreads ties between equally scheduled pages", () => {
  const tiedSchedule: BackgroundPageScheduleEntry[] = [
    { intervalMs: 180_000, nextVisitAt: 500, url: "https://mangabuff.ru/feed" },
    { intervalMs: 600_000, nextVisitAt: 500, url: "https://mangabuff.ru/" },
  ];

  assert.equal(selectBackgroundPageIndex(tiedSchedule, 100, 0), 0);
  assert.equal(selectBackgroundPageIndex(tiedSchedule, 100, 0.9), 1);
});
