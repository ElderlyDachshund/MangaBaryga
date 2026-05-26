import { supportedRanks, type SupportedCardRank } from "./domain.js";

export function passesWantedPagesRule(
  pagesCount: number,
  maxWantedPagesExclusive: number,
): boolean {
  return pagesCount < maxWantedPagesExclusive;
}

export function compareRanks(left: SupportedCardRank, right: SupportedCardRank): number {
  return supportedRanks.indexOf(left) - supportedRanks.indexOf(right);
}

export function passesDefaultRankRule(
  requestedRank: SupportedCardRank,
  offeredRanks: SupportedCardRank[],
): boolean {
  const sameRankCount = offeredRanks.filter((rank) => rank === requestedRank).length;
  const hasHigherRank = offeredRanks.some((rank) => compareRanks(rank, requestedRank) > 0);

  return sameRankCount >= 2 || hasHigherRank;
}
