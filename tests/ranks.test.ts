import assert from "node:assert/strict";
import test from "node:test";
import { classifyRankByColorFeatures } from "../src/ranks.js";

test("classifyRankByColorFeatures keeps the widened E threshold for card 375784", () => {
  const rank = classifyRankByColorFeatures({
    hue: 0.04334393802178527,
    saturation: 0.28284532275948837,
    lightness: 0.25080285635380944,
    coloredPixelRatio: 0.6173913043478261,
  });

  assert.equal(rank, "E");
});

test("classifyRankByColorFeatures keeps the widened A threshold for card 356404", () => {
  const rank = classifyRankByColorFeatures({
    hue: 0.0024419110780344866,
    saturation: 0.5914983300906114,
    lightness: 0.29965134233202195,
    coloredPixelRatio: 0.7335403726708074,
  });

  assert.equal(rank, "A");
});
