/**
 * Tuning constants — every number the design deferred to playtesting lives here, and ONLY
 * here. The harness sweeps these; the engine reads them. Nothing is a magic literal buried in
 * game logic.
 *
 * The model (see docs/GAME_DESIGN.md): a fast outward→inward race. Every non-boss tile is a
 * 1-HP enemy that vaporises on any hit; the single centre Boss is the only multi-hit enemy.
 * Mines are your weapons — detonating one deals `stack` damage across a square whose radius
 * also grows with the stack, and overlapping detonations pump nearby armed mines' stacks up.
 * You build big stacks on inner mines and deliver them to the Boss. The timer does not kill
 * you: it is the score. Faster clear = better rank.
 */

import type { Difficulty, Medal, Tier } from './types'

export interface DifficultyConfig {
  readonly width: number
  readonly height: number
  /** Number of hidden mines (your ammunition). Roughly 14% of the board. */
  readonly mineCount: number
  /** Number of Magnetic Hook bonus tiles (outer rings only). */
  readonly hookCount: number
  /** Cosmetic only: relative mix of enemy *sprites*. All non-boss tiles are 1 HP; the tier
   *  just picks which Tower enemy art shows, so the field has visual variety. */
  readonly tierWeights: Readonly<Record<Tier, number>>
  /** Cosmetic only: how strongly the sprite tiers clump (0 = uniform, 1 = maximally clumped). */
  readonly hardGroundGradient: number
  /** Boss HP. The Boss is the only multi-hit tile; it must take several stacked blasts, so keep
   *  it comfortably above `stackCap` (≈2.5×) or a single maxed mine one-shots the climax. */
  readonly bossHp: number
  /** Target clear time in seconds — the par used for score and medals. NOT a loss timer;
   *  running past it just lowers the score. */
  readonly parSeconds: number
  /** Medal thresholds in seconds (finish at or under → that medal). gold < silver < bronze. */
  readonly goldSeconds: number
  readonly silverSeconds: number
  readonly bronzeSeconds: number
  /** Starting player charge. */
  readonly startingCharge: number
  /** Hard ceiling on the player's charge pool. */
  readonly maxPlayerCharge: number
  /** Passive charge regenerated per second. Charge gates hand-tapping (1 charge per tap), so
   *  keeping it scarce is what makes you rely on blasts rather than tapping the whole board. */
  readonly chargeRegenPerSecond: number
  /** Hard ceiling on a mine's stack. Both blast damage and blast radius scale off the stack,
   *  so this caps how big a single detonation can get. */
  readonly stackCap: number
  /** Hard ceiling on blast radius (Chebyshev). Radius grows slowly with stack up to this. */
  readonly blastRadiusCap: number
  /** Chebyshev radius around the Boss that defines the "near" zone: the wedge of killer mines
   *  spawns entirely within it (nothing else does), and the player/bot gathers exactly the mines
   *  inside it into the Boss-killing blob. Must be wide enough to hold ≈√(2·bossHp) non-adjacent
   *  mines; everything past it is field ordnance, spent only to clear ground. */
  readonly gatherRadius: number
  /** How many killer mines beyond the bare ≈√(2·bossHp) minimum to spawn. This is the hook-reliance
   *  dial: a big margin means even a SPREAD, un-hooked chain finishes the Boss (hooks optional —
   *  easy); a small margin means the mines only chain to a kill once hooked into a tight cluster
   *  (hooks effectively required — hard). */
  readonly killerMargin: number
  /** Stack a mine gains each time it is caught inside another mine's blast (overlap charging). */
  readonly chargeGainPerOverlap: number
  /** Fraction of a detonated mine's stack that converts into the player's charge pool. */
  readonly chargeConversion: number
  /** Multiplier applied to the (par − time) score on this difficulty. */
  readonly scoreDifficultyMultiplier: number
}

/** Blast radius for a given stack: starts at 1, grows one ring every two stacks, capped.
 *  stack 1→r1, 2→r1, 3→r2, 4→r2, 5→r3, 6→r3. */
export function blastRadiusForStack(stack: number, cap: number): number {
  return Math.max(1, Math.min(cap, 1 + Math.floor((stack - 1) / 2)))
}

/** A shared cosmetic sprite mix (skewed toward Common). Difficulties can override. */
const SPRITE_MIX: Record<Tier, number> = { common: 12, advanced: 5, elite: 3, fleet: 2, boss: 0 }

export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyConfig>> = {
  gentle: {
    width: 13,
    height: 13,
    mineCount: 24, // ~14% of 169
    hookCount: 7,
    tierWeights: SPRITE_MIX,
    hardGroundGradient: 0.18,
    bossHp: 18,
    parSeconds: 116,
    goldSeconds: 88,
    silverSeconds: 100,
    bronzeSeconds: 116,
    startingCharge: 8,
    maxPlayerCharge: 12,
    chargeRegenPerSecond: 1.0,
    stackCap: 6,
    blastRadiusCap: 3,
    gatherRadius: 5,
    killerMargin: 6, // easy: spread chain wins on its own, hooks optional
    chargeGainPerOverlap: 1,
    chargeConversion: 2,
    scoreDifficultyMultiplier: 1,
  },
  standard: {
    width: 17,
    height: 17,
    mineCount: 40, // ~14% of 289
    hookCount: 11,
    tierWeights: SPRITE_MIX,
    hardGroundGradient: 0.2,
    bossHp: 30,
    parSeconds: 164,
    goldSeconds: 115,
    silverSeconds: 138,
    bronzeSeconds: 164,
    startingCharge: 9,
    maxPlayerCharge: 14,
    chargeRegenPerSecond: 1.1,
    stackCap: 7,
    blastRadiusCap: 3,
    gatherRadius: 6,
    killerMargin: 3, // standard: needs a few hooks on many boards, hook-free on some
    chargeGainPerOverlap: 1,
    chargeConversion: 2,
    scoreDifficultyMultiplier: 1.6,
  },
  hard: {
    width: 21,
    height: 21,
    mineCount: 62, // ~14% of 441
    hookCount: 16,
    tierWeights: SPRITE_MIX,
    hardGroundGradient: 0.24,
    bossHp: 56,
    parSeconds: 195,
    goldSeconds: 145,
    silverSeconds: 168,
    bronzeSeconds: 195,
    startingCharge: 10,
    maxPlayerCharge: 16,
    chargeRegenPerSecond: 1.2,
    stackCap: 8,
    blastRadiusCap: 3,
    gatherRadius: 7,
    killerMargin: 1, // hard: minimal mines -> must hook a tight cluster; rare seeds win hook-free
    chargeGainPerOverlap: 1,
    chargeConversion: 2,
    scoreDifficultyMultiplier: 2.4,
  },
}

/** Which medal a clear time earns on a difficulty. */
export function medalForTime(cfg: DifficultyConfig, seconds: number): Medal {
  if (seconds <= cfg.goldSeconds) return 'gold'
  if (seconds <= cfg.silverSeconds) return 'silver'
  if (seconds <= cfg.bronzeSeconds) return 'bronze'
  return 'none'
}
