import type { Page } from "playwright";
import sharp from "sharp";
import {
  assertMangabuffPageReady,
  MangabuffInteractionBlockedError,
} from "./browser-safety.js";
import { supportedRanks, type CardRank, type SupportedCardRank } from "./domain.js";
import { rankSamples, type RankSample } from "./rank-samples.js";

sharp.cache(false);
sharp.concurrency(1);

export interface RankColorFeatures {
  hue: number;
  saturation: number;
  lightness: number;
  coloredPixelRatio: number;
  brightHue?: number;
  brightSaturation?: number;
  brightLightness?: number;
  brightPixelRatio?: number;
}

export interface RankRecognitionResult {
  rank: CardRank;
  features: RankColorFeatures;
}

export interface RankSampleCheckResult extends RankSample {
  recognizedRank?: CardRank;
  ok: boolean;
  reason?: string;
  features?: RankColorFeatures;
}

export async function verifyRankSamples(page: Page): Promise<RankSampleCheckResult[]> {
  const results: RankSampleCheckResult[] = [];

  for (const sample of rankSamples) {
    try {
      const recognized = await recognizeCardPageRank(page, sample.cardUrl);

      results.push({
        ...sample,
        recognizedRank: recognized.rank,
        ok: recognized.rank === sample.expectedRank,
        features: recognized.features,
      });
    } catch (error) {
      results.push({
        ...sample,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export async function recognizeCardPageRank(
  page: Page,
  cardUrl: string,
): Promise<RankRecognitionResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await page.goto(cardUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      await assertMangabuffPageReady(page, response?.status());

      const imageSrc = await page.locator('img[src*="/img/cards/"]').first().getAttribute("src", {
        timeout: 15_000,
      });

      if (!imageSrc) {
        throw new Error(`Не удалось найти изображение карты на странице ${cardUrl}.`);
      }

      return recognizeCardRankFromImage(page, imageSrc);
    } catch (error) {
      if (error instanceof MangabuffInteractionBlockedError) {
        throw error;
      }

      lastError = error;

      if (attempt < 3) {
        await page.waitForTimeout(1_000);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function recognizeCardRankFromImage(
  page: Page,
  imageUrl: string,
): Promise<RankRecognitionResult> {
  const features = await extractRankColorFeatures(page, imageUrl);
  const rank = classifyRankByColorFeatures(features);

  return { rank, features };
}

export async function recognizeCardRankFromImageBytes(bytes: Uint8Array): Promise<RankRecognitionResult> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const features = extractRankColorFeaturesFromRgba(data, info.width, info.height);
  const rank = classifyRankByColorFeatures(features);

  return { rank, features };
}

export function classifyRankByColorFeatures(features: RankColorFeatures): CardRank {
  const { hue, saturation, lightness, coloredPixelRatio } = features;
  const isBrightStandardD = isBrightStandardDVariant(features);

  if (coloredPixelRatio < 0.01 && !isBrightStandardD) {
    return "unknown";
  }

  if (isInRange(hue, 0.57, 0.61) && isInRange(lightness, 0.08, 0.115)) {
    return "B";
  }

  if (
    isInRange(hue, 0.575, 0.6) &&
    saturation >= 0.55 &&
    isInRange(lightness, 0.36, 0.455) &&
    coloredPixelRatio >= 0.6
  ) {
    return "P";
  }

  if (
    (isInRange(hue, 0.54, 0.58) && isInRange(lightness, 0.24, 0.36) && coloredPixelRatio >= 0.5) ||
    isLightDisputedDVariant(features) ||
    isBrightStandardD
  ) {
    return "D";
  }

  if (isInRange(hue, 0.39, 0.49) && saturation >= 0.7 && coloredPixelRatio >= 0.45) {
    return "G";
  }

  if (isInRange(hue, 0.075, 0.105) && saturation >= 0.55 && coloredPixelRatio >= 0.55) {
    return "C";
  }

  if (
    (isInRange(hue, 0.925, 0.975) && saturation >= 0.55 && coloredPixelRatio >= 0.6) ||
    isMutedSVariant(features)
  ) {
    return "S";
  }

  if (
    (hue <= 0.02 || hue >= 0.985) &&
    saturation >= 0.58 &&
    isInRange(lightness, 0.29, 0.37) &&
    coloredPixelRatio >= 0.65
  ) {
    return "A";
  }

  if (
    isInRange(hue, 0.025, 0.055) &&
    isInRange(saturation, 0.27, 0.65) &&
    isInRange(lightness, 0.15, 0.27) &&
    coloredPixelRatio >= 0.5
  ) {
    return "E";
  }

  return "unknown";
}

function isLightDisputedDVariant(features: RankColorFeatures): boolean {
  return (
    isInRange(features.hue, 0.58, 0.59) &&
    isInRange(features.saturation, 0.22, 0.26) &&
    isInRange(features.lightness, 0.757, 0.766) &&
    isInRange(features.coloredPixelRatio, 0.025, 0.032)
  );
}

function isBrightStandardDVariant(features: RankColorFeatures): boolean {
  return (
    isInRange(features.brightHue ?? 0, 0.56, 0.6) &&
    isInRange(features.brightSaturation ?? 0, 0.2, 0.32) &&
    isInRange(features.brightLightness ?? 0, 0.88, 0.95) &&
    isInRange(features.brightPixelRatio ?? 0, 0.22, 0.36)
  );
}

function isMutedSVariant(features: RankColorFeatures): boolean {
  return (
    isInRange(features.hue, 0.94, 0.95) &&
    isInRange(features.saturation, 0.5, 0.54) &&
    isInRange(features.lightness, 0.45, 0.5) &&
    isInRange(features.coloredPixelRatio, 0.68, 0.75)
  );
}

function extractRankColorFeaturesFromRgba(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
): RankColorFeatures {
  const cropWidth = Math.max(1, Math.round(imageWidth * 0.16));
  const cropHeight = Math.max(1, Math.min(imageHeight, Math.round(imageWidth * 0.12)));
  let hueX = 0;
  let hueY = 0;
  let saturationSum = 0;
  let lightnessSum = 0;
  let coloredPixelCount = 0;
  let brightHueX = 0;
  let brightHueY = 0;
  let brightSaturationSum = 0;
  let brightLightnessSum = 0;
  let brightPixelCount = 0;
  const totalPixelCount = cropWidth * cropHeight;

  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const index = (y * imageWidth + x) * 4;
      const r = imageData[index] / 255;
      const g = imageData[index + 1] / 255;
      const b = imageData[index + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let hue = 0;
      let saturation = 0;
      const lightness = (max + min) / 2;

      if (max !== min) {
        const delta = max - min;
        saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

        switch (max) {
          case r:
            hue = (g - b) / delta + (g < b ? 6 : 0);
            break;
          case g:
            hue = (b - r) / delta + 2;
            break;
          case b:
            hue = (r - g) / delta + 4;
            break;
        }

        hue /= 6;
      }

      if (saturation > 0.15 && lightness > 0.85) {
        const angle = hue * 2 * Math.PI;
        brightHueX += Math.cos(angle);
        brightHueY += Math.sin(angle);
        brightSaturationSum += saturation;
        brightLightnessSum += lightness;
        brightPixelCount += 1;
      }

      if (saturation <= 0.2 || lightness <= 0.08 || lightness >= 0.85) {
        continue;
      }

      const angle = hue * 2 * Math.PI;
      hueX += Math.cos(angle);
      hueY += Math.sin(angle);
      saturationSum += saturation;
      lightnessSum += lightness;
      coloredPixelCount += 1;
    }
  }

  if (coloredPixelCount === 0) {
    return {
      hue: 0,
      saturation: 0,
      lightness: 0,
      coloredPixelRatio: 0,
      ...brightFeatures(),
    };
  }

  const hue = (Math.atan2(hueY, hueX) / (2 * Math.PI) + 1) % 1;

  return {
    hue,
    saturation: saturationSum / coloredPixelCount,
    lightness: lightnessSum / coloredPixelCount,
    coloredPixelRatio: coloredPixelCount / totalPixelCount,
    ...brightFeatures(),
  };

  function brightFeatures(): Pick<
    RankColorFeatures,
    "brightHue" | "brightSaturation" | "brightLightness" | "brightPixelRatio"
  > {
    if (brightPixelCount === 0) {
      return {
        brightHue: 0,
        brightSaturation: 0,
        brightLightness: 0,
        brightPixelRatio: 0,
      };
    }

    return {
      brightHue: (Math.atan2(brightHueY, brightHueX) / (2 * Math.PI) + 1) % 1,
      brightSaturation: brightSaturationSum / brightPixelCount,
      brightLightness: brightLightnessSum / brightPixelCount,
      brightPixelRatio: brightPixelCount / totalPixelCount,
    };
  }
}

async function extractRankColorFeatures(page: Page, imageUrl: string): Promise<RankColorFeatures> {
  return page.evaluate(async (sourceUrl) => {
    const image = new Image();
    image.crossOrigin = "anonymous";

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Не удалось загрузить изображение карты: ${sourceUrl}`));
      image.src = new URL(sourceUrl, "https://mangabuff.ru").href;
    });

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      throw new Error("Не удалось создать canvas для распознавания ранга.");
    }

    context.drawImage(image, 0, 0);

    const cropWidth = Math.round(image.naturalWidth * 0.16);
    const cropHeight = Math.round(image.naturalWidth * 0.12);
    const imageData = context.getImageData(0, 0, cropWidth, cropHeight).data;
    let hueX = 0;
    let hueY = 0;
    let saturationSum = 0;
    let lightnessSum = 0;
    let coloredPixelCount = 0;
    let brightHueX = 0;
    let brightHueY = 0;
    let brightSaturationSum = 0;
    let brightLightnessSum = 0;
    let brightPixelCount = 0;
    const totalPixelCount = cropWidth * cropHeight;

    for (let index = 0; index < imageData.length; index += 4) {
      const r = imageData[index] / 255;
      const g = imageData[index + 1] / 255;
      const b = imageData[index + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      let hue = 0;
      let saturation = 0;
      const lightness = (max + min) / 2;

      if (max !== min) {
        const delta = max - min;
        saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

        switch (max) {
          case r:
            hue = (g - b) / delta + (g < b ? 6 : 0);
            break;
          case g:
            hue = (b - r) / delta + 2;
            break;
          case b:
            hue = (r - g) / delta + 4;
            break;
        }

        hue /= 6;
      }

      if (saturation > 0.15 && lightness > 0.85) {
        const angle = hue * 2 * Math.PI;
        brightHueX += Math.cos(angle);
        brightHueY += Math.sin(angle);
        brightSaturationSum += saturation;
        brightLightnessSum += lightness;
        brightPixelCount += 1;
      }

      if (saturation <= 0.2 || lightness <= 0.08 || lightness >= 0.85) {
        continue;
      }

      const angle = hue * 2 * Math.PI;
      hueX += Math.cos(angle);
      hueY += Math.sin(angle);
      saturationSum += saturation;
      lightnessSum += lightness;
      coloredPixelCount += 1;
    }

    if (coloredPixelCount === 0) {
      return {
        hue: 0,
        saturation: 0,
        lightness: 0,
        coloredPixelRatio: 0,
        ...brightFeatures(),
      };
    }

    const hue = (Math.atan2(hueY, hueX) / (2 * Math.PI) + 1) % 1;

    return {
      hue,
      saturation: saturationSum / coloredPixelCount,
      lightness: lightnessSum / coloredPixelCount,
      coloredPixelRatio: coloredPixelCount / totalPixelCount,
      ...brightFeatures(),
    };

    function brightFeatures() {
      if (brightPixelCount === 0) {
        return {
          brightHue: 0,
          brightSaturation: 0,
          brightLightness: 0,
          brightPixelRatio: 0,
        };
      }

      return {
        brightHue: (Math.atan2(brightHueY, brightHueX) / (2 * Math.PI) + 1) % 1,
        brightSaturation: brightSaturationSum / brightPixelCount,
        brightLightness: brightLightnessSum / brightPixelCount,
        brightPixelRatio: brightPixelCount / totalPixelCount,
      };
    }
  }, imageUrl);
}

function isInRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function isSupportedCardRank(value: string): value is SupportedCardRank {
  return supportedRanks.includes(value as SupportedCardRank);
}
