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
  /** Max HP a single hand-tap removes (also the charge it costs). Commons clear in one tap;
   *  Advanced take ~2, Elite ~3, Fleet ~4, and the Boss a dozen-plus — the HP bar is the
   *  pacing. A charged mine still clears a cluster far faster. Lower = slower to hand-clear. */
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
  /** Fraction of a tile's MAX HP a blast removes at the core ring, per point of mine charge.
   *  e.g. 0.5 with a charge-1 mine strips 50% of max HP at distance 1; a charge-2 mine clears
   *  outright. Because it scales with the tile's own HP, a blast never one-shots a full-HP
   *  tough tile — it takes the same number of blasts as a weak one. Falls off with distance
   *  (blastFalloff). */
  readonly blastPct: number
  /** Per-ring multiplier as a blast travels outward from the mine. The adjacent ring
   *  (distance 1) takes the full `blastPct × charge` fraction; distance 2 takes that ×
   *  blastFalloff, distance 3 × blastFalloff², and so on. < 1 makes a blast an explosion
   *  (strong core, weak edge) instead of a uniform slab, so tile HP decides what survives
   *  at range. */
  readonly blastFalloff: number
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
  /** Passive charge regenerated per second (Option 1: a second charge source so mines aren't
   *  the only one). 0 = off. */
  readonly chargeRegenPerSecond: number
  readonly scoreDifficultyMultiplier: number
}

/**
 * A clean clear costs the tile's hidden HP in player charge (1 charge per HP). The class is
 * the *visible* band; the exact cost within it is hidden, and that gap is the risk. `boss`
 * is far tougher than the ramp and only ever appears once, at board centre.
 */
const SHARED_BANDS: Record<Tier, TierBand> = {
  common: { minHp: 2, maxHp: 4 },
  advanced: { minHp: 5, maxHp: 9 },
  elite: { minHp: 10, maxHp: 16 },
  fleet: { minHp: 18, maxHp: 28 },
  boss: { minHp: 60, maxHp: 90 },
}

export const SCORE_CHAIN_WEIGHT = 25
export const SCORE_CRACK_WEIGHT = 15

export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyConfig>> = {
  gentle: {
    width: 9,
    height: 9,
    mineCount: 16,
    handTapDamage: 6,
    tierWeights: { common: 13, advanced: 4, elite: 1.6, fleet: 0.5, boss: 0 },
    hardGroundGradient: 0.16,
    maxMineCharge: 6,
    bands: SHARED_BANDS,
    timerSeconds: 300,
    startingCharge: 9,
    maxPlayerCharge: 10,
    blastPct: 0.65,
    blastRadius: 2,
    blastFalloff: 0.4,
    chargeGainPerOverlap: 1,
    chargeConversion: 3,
    chargeRegenPerSecond: 1.2,
    scoreDifficultyMultiplier: 1,
  },
  standard: {
    width: 11,
    height: 11,
    mineCount: 12,
    handTapDamage: 6,
    tierWeights: { common: 11, advanced: 4.5, elite: 2.2, fleet: 0.9, boss: 0 },
    hardGroundGradient: 0.2,
    maxMineCharge: 6,
    bands: SHARED_BANDS,
    timerSeconds: 420,
    startingCharge: 9,
    maxPlayerCharge: 10,
    blastPct: 0.65,
    blastRadius: 2,
    blastFalloff: 0.4,
    chargeGainPerOverlap: 1,
    chargeConversion: 3,
    chargeRegenPerSecond: 1.3,
    scoreDifficultyMultiplier: 1.6,
  },
  hard: {
    width: 15,
    height: 15,
    mineCount: 11,
    handTapDamage: 6,
    tierWeights: { common: 9, advanced: 4.5, elite: 2.6, fleet: 1.3, boss: 0 },
    hardGroundGradient: 0.26,
    maxMineCharge: 7,
    bands: SHARED_BANDS,
    timerSeconds: 1000,
    startingCharge: 12,
    maxPlayerCharge: 14,
    blastPct: 0.65,
    blastRadius: 2,
    blastFalloff: 0.4,
    chargeGainPerOverlap: 1,
    chargeConversion: 3,
    chargeRegenPerSecond: 1.5,
    scoreDifficultyMultiplier: 2.4,
  },
}
