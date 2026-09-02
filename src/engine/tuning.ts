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
  /** Boss shield: a buffer that absorbs blast damage BEFORE HP, and — unlike HP — regrows if you
   *  leave the Boss alone (see below). It stops a single overkill cluster from one-shotting the
   *  climax and, with regen, punishes clearing the whole board in peace then alpha-striking. */
  readonly bossShield: number
  /** Moves the Boss can go UNHARMED before its shield starts regrowing (a grace window so a normal
   *  gather-then-strike isn't fighting regen the whole time). */
  readonly bossRegenDelayMoves: number
  /** Shield regained per move once past the delay, capped at `bossShield`. Keep it slow — it's a
   *  "don't dawdle" nudge, not a wall. */
  readonly bossShieldRegenPerMove: number
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
  /** How much stack a mine passes on when it detonates NEXT TO a still-armed mine — and it scales
   *  with the DETONATOR's own stack: `overlapBoost(sourceStack)`. A fat mine hands a bigger boost
   *  than a small one (a 4× lifts a 1× to 3×), so building one big mine and setting it off beside
   *  the cluster snowballs the whole blob. See `overlapBoost`. */
  readonly overlapBoostPerStack: number
  /** Shrapnel: on top of vaporising its radius, a blast also kills `floor(stack · shrapnelPerStack)`
   *  extra enemies that merely TOUCH the blast (the ring just outside it). This is the field-clearing
   *  payoff for a big stack — a reason to grow mines even when the Boss is nowhere near. At 1.0 a 3×
   *  blast takes 3 bonus enemies with it. */
  readonly shrapnelPerStack: number
  /** Hard cap (Chebyshev, from the blast centre) on how far shrapnel can reach. The natural ring is
   *  one tile outside the blast (radius+1), but for a big blast that ring is far from centre — so this
   *  caps it: shrapnel never lands beyond a full-size blast's footprint. A big mine can shred a LOT,
   *  but it can't reach clear across the board. */
  readonly shrapnelMaxReach: number
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

/** Stack handed to a neighbouring armed mine when a mine of `sourceStack` detonates beside it.
 *  Scales with the detonator's stack (`perStack`, default 0.5) but never drops below 1, so chains
 *  never stall: 1×/2×/3× still pass +1, a 4× passes +2, a 6× passes +3. The engine, the bot's
 *  lethality prediction, and its detonation ordering ALL route through this one function so they
 *  can never disagree about how fat a chain becomes. */
export function overlapBoost(sourceStack: number, perStack: number): number {
  return Math.max(1, Math.floor(sourceStack * perStack))
}

/** A shared cosmetic sprite mix (skewed toward Common). Difficulties can override. */
const SPRITE_MIX: Record<Tier, number> = { common: 12, advanced: 5, elite: 3, fleet: 2, boss: 0 }

export const DIFFICULTIES: Readonly<Record<Difficulty, DifficultyConfig>> = {
  gentle: {
    width: 15,
    height: 15,
    mineCount: 34,
    hookCount: 30,
    tierWeights: SPRITE_MIX,
    hardGroundGradient: 0.18,
    bossHp: 14,
    bossShield: 5,
    bossRegenDelayMoves: 4,
    bossShieldRegenPerMove: 1,
    parSeconds: 50,
    goldSeconds: 30,
    silverSeconds: 38,
    bronzeSeconds: 50,
    startingCharge: 18, // small: you start able to tap only a little; detonations fund the rest
    maxPlayerCharge: 40, // the ceiling you can EARN back up to by detonating (start is well below it)
    chargeRegenPerSecond: 0, // earned, not regenerated: detonate mines to fund tapping
    stackCap: 6,
    blastRadiusCap: 3,
    gatherRadius: 4,
    killerMargin: 6, // easy: spread chain wins on its own, hooks optional
    overlapBoostPerStack: 0.5, // a 4× lifts a neighbour +2 (→3×); 1–3× still pass +1
    shrapnelPerStack: 1, // a 3× blast also takes 3 touching enemies with it
    shrapnelMaxReach: 3, // never past a full-size blast (cheb 3); trims big mines' cheb-4 shrapnel
    chargeConversion: 0.5, // a detonated mine refunds round(stack·0.5) charge — bigger mine, more back
    scoreDifficultyMultiplier: 1,
  },
  standard: {
    width: 17,
    height: 17,
    mineCount: 42,
    hookCount: 45,
    tierWeights: SPRITE_MIX,
    hardGroundGradient: 0.2,
    bossHp: 30,
    bossShield: 9,
    bossRegenDelayMoves: 4,
    bossShieldRegenPerMove: 1,
    parSeconds: 66,
    goldSeconds: 44,
    silverSeconds: 54,
    bronzeSeconds: 66,
    startingCharge: 22, // small: you start able to tap only a little; detonations fund the rest
    maxPlayerCharge: 48, // the ceiling you can EARN back up to by detonating (start is well below it)
    chargeRegenPerSecond: 0,
    stackCap: 7,
    blastRadiusCap: 3,
    gatherRadius: 4,
    killerMargin: 3, // standard: needs a few hooks on many boards, hook-free on some
    overlapBoostPerStack: 0.5, // a 4× lifts a neighbour +2 (→3×); 1–3× still pass +1
    shrapnelPerStack: 1, // a 3× blast also takes 3 touching enemies with it
    shrapnelMaxReach: 3, // never past a full-size blast (cheb 3); trims big mines' cheb-4 shrapnel
    chargeConversion: 0.5, // a detonated mine refunds round(stack·0.5) charge — bigger mine, more back
    scoreDifficultyMultiplier: 1.6,
  },
  hard: {
    width: 21,
    height: 21,
    mineCount: 62, // ~14% of 441
    hookCount: 70,
    tierWeights: SPRITE_MIX,
    hardGroundGradient: 0.24,
    bossHp: 42,
    bossShield: 12,
    bossRegenDelayMoves: 4,
    bossShieldRegenPerMove: 2,
    parSeconds: 90,
    goldSeconds: 60,
    silverSeconds: 74,
    bronzeSeconds: 90,
    startingCharge: 26, // small: you start able to tap only a little; detonations fund the rest
    maxPlayerCharge: 56, // the ceiling you can EARN back up to by detonating (start is well below it)
    chargeRegenPerSecond: 0,
    stackCap: 8,
    blastRadiusCap: 3,
    gatherRadius: 5,
    killerMargin: 1, // hard: minimal mines -> must hook a tight cluster; rare seeds win hook-free
    overlapBoostPerStack: 0.5, // a 4× lifts a neighbour +2 (→3×); 1–3× still pass +1
    shrapnelPerStack: 1, // a 3× blast also takes 3 touching enemies with it
    shrapnelMaxReach: 3, // never past a full-size blast (cheb 3); trims big mines' cheb-4 shrapnel
    chargeConversion: 0.5, // a detonated mine refunds round(stack·0.5) charge — bigger mine, more back
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
