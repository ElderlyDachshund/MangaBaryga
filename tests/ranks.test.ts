import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { classifyRankByColorFeatures, recognizeCardRankFromImageBytes } from "../src/ranks.js";

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

test("classifyRankByColorFeatures recognizes the lighter D variant for rejected trades", () => {
  const samples = [
    {
      hue: 0.5870755887003044,
      saturation: 0.24112497138093697,
      lightness: 0.7575467396260832,
      coloredPixelRatio: 0.02670807453416149,
    },
    {
      hue: 0.5844603547396026,
      saturation: 0.23906830591088785,
      lightness: 0.7626517273576099,
      coloredPixelRatio: 0.02608695652173913,
    },
    {
      hue: 0.5814978214279789,
      saturation: 0.23282370964045207,
      lightness: 0.7634117647058822,
      coloredPixelRatio: 0.031055900621118012,
    },
  ];

  for (const sample of samples) {
    assert.equal(classifyRankByColorFeatures(sample), "D");
  }
});

test("recognizeCardRankFromImageBytes keeps the lighter D regression for trade 131079 image", async () => {
  const image = await loadRankFixture("131079.png");
  const result = await recognizeCardRankFromImageBytes(image);

  assert.equal(result.rank, "D");
  assert.ok(result.features.lightness >= 0.757);
  assert.ok(result.features.lightness <= 0.764);
  assert.ok(result.features.coloredPixelRatio >= 0.025);
  assert.ok(result.features.coloredPixelRatio <= 0.032);
});

test("recognizeCardRankFromImageBytes classifies disputed trade images as D", async () => {
  const fixtures = ["131079.png", "46694.png", "250123.png"];

  for (const fixture of fixtures) {
    const image = await loadRankFixture(fixture);
    const result = await recognizeCardRankFromImageBytes(image);

    assert.equal(result.rank, "D");
  }
});

test("recognizeCardRankFromImageBytes keeps the lowered E lightness floor for a dark E image", async () => {
  const image = await createRankImage(0.04, 0.35, 0.16);
  const result = await recognizeCardRankFromImageBytes(image);

  assert.equal(result.rank, "E");
  assert.ok(result.features.lightness < 0.18);
  assert.ok(result.features.lightness >= 0.15);
});

async function createRankImage(hue: number, saturation: number, lightness: number): Promise<Uint8Array> {
  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  const buffer = await sharp({
    create: {
      background: { alpha: 1, b: blue, g: green, r: red },
      channels: 4,
      height: 100,
      width: 100,
    },
  })
    .png()
    .toBuffer();

  return new Uint8Array(buffer);
}

async function loadRankFixture(fileName: string): Promise<Uint8Array> {
  const buffer = await fs.readFile(new URL(`./fixtures/ranks/disputed/${fileName}`, import.meta.url));
  return new Uint8Array(buffer);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue * 6;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const offset = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment < 1) {
    red = chroma;
    green = secondary;
  } else if (segment < 2) {
    red = secondary;
    green = chroma;
  } else if (segment < 3) {
    green = chroma;
    blue = secondary;
  } else if (segment < 4) {
    green = secondary;
    blue = chroma;
  } else if (segment < 5) {
    red = secondary;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondary;
  }

  return [
    Math.round((red + offset) * 255),
    Math.round((green + offset) * 255),
    Math.round((blue + offset) * 255),
  ];
}
