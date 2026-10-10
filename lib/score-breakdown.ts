import { calculateNetScore } from './scoring.ts';

export type ScoreBreakdown = {
  earnedBase: number;
  earnedAdditional: number;
  basePenalty: number;
  additionalPenalty: number;
  totalPenalty: number;
  rawScore: number;
  netScore: number;
};

export function scoreBreakdown(
  earnedBase: number,
  earnedAdditional: number,
  basePenalty: number,
  additionalPenalty: number,
  baseMaxScore: number,
): ScoreBreakdown {
  const totalPenalty = basePenalty + additionalPenalty;
  const earned = earnedBase + earnedAdditional;
  return {
    earnedBase, earnedAdditional, basePenalty, additionalPenalty, totalPenalty,
    rawScore: earned - totalPenalty,
    netScore: calculateNetScore(earned, totalPenalty, baseMaxScore),
  };
}
