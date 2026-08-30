/**
 * Tuning constants — every number the design deferred to playtesting lives here, and
 * ONLY here. The harness sweeps these; the engine reads them. Nothing is a magic literal
 * buried in game logic.
 *
 * These are starting guesses, not decisions. See docs/GAME_DESIGN.md § "What is settled".
 */

import type { Difficulty, Tier } from './types'

export interface TierBand {
  readonly minHp: number
  readonly maxHp: number
  /** Player-charge cost to cleanly clear a ground tile of this tier. */
  readonly clickCost: number
}

export interface DifficultyConfig {
  readonly width: number
  readonly height: number
  /** Fraction of tiles that hide a mine. Higher than classic (~0.16) — mines are ammo. */
  readonly mineDensity: number
  /** Relative weights for tier assignment across the board. */
  readonly tierWeights: Readonly<Record<Tier, number>>
  /** How strongly tough tiles cluster together (0 = uniform, 1 = maximally clumped). */
  readonly hardGroundGradient: number
  readonly bands: Readonly<Record<Tier, TierBand>>
  /** Fixed timer budget in seconds. Generous by design; kills stalls, not thinking. */
  readonly timerSeconds: number
  /** Starting player charge. Must cover at least a few Light clears. */
  readonly startingCharge: number
  /** Base blast damage before the mine's charge multiplier. */
  readonly blastBaseDamage: number
  /** Chebyshev radius of a detonation. Tight by design. */
  readonly blastRadius: number
  /** Charge a mine gains per overlapping blast. */
  readonly chargeGainPerOverlap: number
  /** Fraction of a detonated mine's charge that converts into the player pool. */
  readonly chargeConversion: number
  /** Base seconds lost on a chip (over-HP click). Escalates with repeats. */
  readonly crackTimePenalty: number
  /** Multiplier applied to crackTimePenalty per repeated chip on the same tile. */
  readonly crackPenaltyEscalation: number
  /** Fraction of remaining HP knocked off a tile per chip. */
  readonly crackKnockdown: number
  readonly scoreDifficultyMultiplier: number
}

const SHARED_BANDS: Record<Tier, TierBand> = {
  light: { minHp: 1, maxHp: 2, clickCost: 1 },
  medium: { minHp: 2, maxHp: 4, clickCost: 3 },
  heavy: { minHp: 4, maxHp: 6, clickCost: 6 },
  elite: { minHp: 6, maxHp: 9, clickCost: 10 },
}

export const SCORE_CHAIN_WEIGHT = 25
export const SCORE_CRACK_WEIGHT = 15

export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyConfig>> = {
  gentle: {
    width: 9,
    height: 9,
    mineDensity: 0.22,
    tierWeights: { light: 6, medium: 3, heavy: 1.5, elite: 0.5 },
    hardGroundGradient: 0.4,
    bands: SHARED_BANDS,
    timerSeconds: 300,
    startingCharge: 8,
    blastBaseDamage: 2,
    blastRadius: 1,
    chargeGainPerOverlap: 1,
    chargeConversion: 1,
    crackTimePenalty: 4,
    crackPenaltyEscalation: 1.6,
    crackKnockdown: 0.34,
    scoreDifficultyMultiplier: 1,
  },
  standard: {
    width: 12,
    height: 12,
    mineDensity: 0.24,
    tierWeights: { light: 5, medium: 3.5, heavy: 2, elite: 1 },
    hardGroundGradient: 0.55,
    bands: SHARED_BANDS,
    timerSeconds: 420,
    startingCharge: 8,
    blastBaseDamage: 2,
    blastRadius: 1,
    chargeGainPerOverlap: 1,
    chargeConversion: 1,
    crackTimePenalty: 5,
    crackPenaltyEscalation: 1.7,
    crackKnockdown: 0.3,
    scoreDifficultyMultiplier: 1.6,
  },
  hard: {
    width: 16,
    height: 16,
    mineDensity: 0.26,
    tierWeights: { light: 4, medium: 3.5, heavy: 2.5, elite: 1.5 },
    hardGroundGradient: 0.7,
    bands: SHARED_BANDS,
    timerSeconds: 600,
    startingCharge: 8,
    blastBaseDamage: 2,
    blastRadius: 1,
    chargeGainPerOverlap: 1,
    chargeConversion: 1,
    crackTimePenalty: 6,
    crackPenaltyEscalation: 1.8,
    crackKnockdown: 0.28,
    scoreDifficultyMultiplier: 2.4,
  },
}
