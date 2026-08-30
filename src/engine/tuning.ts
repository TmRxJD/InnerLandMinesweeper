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
}

export interface DifficultyConfig {
  readonly width: number
  readonly height: number
  /** Number of mines on the board — an explicit cap. Mines are the fast way to clear tough
   *  tiles; you *can* chip tough tiles by hand, but slowly (see handTapDamage), so mines
   *  stay valuable while their count can drop with difficulty. */
  readonly mineCount: number
  /** Max HP a single hand-tap removes. Commons (HP ≤ 2) still clear in one tap; tough tiles
   *  take many taps, so a blast (9× charge, uncapped) is far better. Lower = tougher to
   *  hand-clear, so scarce mines matter more. */
  readonly handTapDamage: number
  /** Relative weights for tier assignment across the board. */
  readonly tierWeights: Readonly<Record<Tier, number>>
  /** How strongly tough tiles cluster together (0 = uniform, 1 = maximally clumped). */
  readonly hardGroundGradient: number
  /** HP band per enemy class, including the single centre `boss`. */
  readonly bands: Readonly<Record<Tier, TierBand>>
  /** Fixed timer budget in seconds. Generous by design; kills stalls, not thinking. */
  readonly timerSeconds: number
  /** Starting player charge. Must cover at least a few Common clears. */
  readonly startingCharge: number
  /** Hard ceiling on the player's charge pool — detonations can't inflate it past this. */
  readonly maxPlayerCharge: number
  /** Base blast damage before the mine's charge multiplier. */
  readonly blastBaseDamage: number
  /** Chebyshev radius of a detonation. Blasts vaporise without revealing numbers, so a
   *  wider radius clears more ground without leaking information — it is the main engine
   *  of board clearing, not a scanner. */
  readonly blastRadius: number
  /** Charge a mine gains per overlapping blast. */
  readonly chargeGainPerOverlap: number
  /** Hard ceiling on a mine's charge multiplier — bounds late-game blast damage. */
  readonly maxMineCharge: number
  /** Fraction of a detonated mine's charge that converts into the player pool. */
  readonly chargeConversion: number
  readonly scoreDifficultyMultiplier: number
}

/**
 * A clean clear costs the tile's hidden HP in player charge (1 charge per HP). The class is
 * the *visible* band; the exact cost within it is hidden, and that gap is the risk. `boss`
 * is far tougher than the ramp and only ever appears once, at board centre.
 */
const SHARED_BANDS: Record<Tier, TierBand> = {
  common: { minHp: 1, maxHp: 2 },
  advanced: { minHp: 2, maxHp: 4 },
  elite: { minHp: 4, maxHp: 6 },
  fleet: { minHp: 6, maxHp: 9 },
  boss: { minHp: 20, maxHp: 32 },
}

export const SCORE_CHAIN_WEIGHT = 25
export const SCORE_CRACK_WEIGHT = 15

export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyConfig>> = {
  gentle: {
    width: 9,
    height: 9,
    mineCount: 18,
    handTapDamage: 4,
    tierWeights: { common: 13, advanced: 4, elite: 1.6, fleet: 0.5, boss: 0 },
    hardGroundGradient: 0.16,
    maxMineCharge: 6,
    bands: SHARED_BANDS,
    timerSeconds: 300,
    startingCharge: 9,
    maxPlayerCharge: 10,
    blastBaseDamage: 9,
    blastRadius: 2,
    chargeGainPerOverlap: 1,
    chargeConversion: 3,
    scoreDifficultyMultiplier: 1,
  },
  standard: {
    width: 11,
    height: 11,
    mineCount: 28,
    handTapDamage: 4,
    tierWeights: { common: 11, advanced: 4.5, elite: 2.2, fleet: 0.9, boss: 0 },
    hardGroundGradient: 0.2,
    maxMineCharge: 6,
    bands: SHARED_BANDS,
    timerSeconds: 420,
    startingCharge: 9,
    maxPlayerCharge: 10,
    blastBaseDamage: 9,
    blastRadius: 2,
    chargeGainPerOverlap: 1,
    chargeConversion: 3,
    scoreDifficultyMultiplier: 1.6,
  },
  hard: {
    width: 15,
    height: 15,
    mineCount: 50,
    handTapDamage: 4,
    tierWeights: { common: 9, advanced: 4.5, elite: 2.6, fleet: 1.3, boss: 0 },
    hardGroundGradient: 0.26,
    maxMineCharge: 7,
    bands: SHARED_BANDS,
    timerSeconds: 600,
    startingCharge: 12,
    maxPlayerCharge: 14,
    blastBaseDamage: 9,
    blastRadius: 2,
    chargeGainPerOverlap: 1,
    chargeConversion: 3,
    scoreDifficultyMultiplier: 2.4,
  },
}
