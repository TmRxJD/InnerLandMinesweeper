/**
 * Headless playout bots. None of these *deduce* — a real solver comes later. Their job is
 * to pressure-test the economy and answer two questions from tuning.ts:
 *
 *   1. Are boards reasonably completable within the timer? (greedy)
 *   2. Does ignoring the economy and brute-clicking win? (blindProber — it must NOT)
 *
 * A Bot inspects a BoardSnapshot and returns one action, or null to pass (which the runner
 * treats as "nothing useful to do").
 */

import type { BoardSnapshot, TileView } from '../engine/types'
import { autoPlay, type AutoAction } from '../engine/auto-player'

export type Action = AutoAction

export interface Bot {
  readonly name: string
  step(snap: BoardSnapshot): Action | null
}

function covered(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'covered' || t.state === 'cracked')
}

function armed(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'armed')
}

/**
 * The sensible player: the shared reference strategy (also used by the in-game demo). It is
 * the proxy for "can a reasonable player finish this board?"
 */
export const greedyBot: Bot = {
  name: 'greedy',
  step: autoPlay,
}

/**
 * The SAME reference player with hooks switched off — it chains the mines where they spawned and
 * never gathers. Not a strategy anyone would choose; it is a measuring stick. Its finish-rate per
 * difficulty is how hook-dependent that difficulty is: high on easy (hooks optional), low on hard
 * (hooks required). It is deliberately a floor, so real no-hook play sits somewhere above it.
 */
export const noHookBot: Bot = {
  name: 'noHook',
  step: snap => autoPlay(snap, { useHooks: false }),
}

/**
 * The adversary. Ignores charge entirely: it blind-clicks every covered tile in order
 * (arming mines for free, chipping ground for time), detonating only to keep clicking.
 * If the escalating chip penalty is tuned right, this loses to the clock. If it wins or
 * beats greedy, the constants are wrong — that is the whole point of running it.
 */
export const blindProberBot: Bot = {
  name: 'blindProber',
  step(snap) {
    const cov = covered(snap)
    if (cov.length > 0) {
      // Row-major order, no regard for tier or affordability.
      cov.sort((a, b) => a.coord.y - b.coord.y || a.coord.x - b.coord.x)
      return { type: 'reveal', coord: cov[0]!.coord }
    }
    const mines = armed(snap)
    if (mines.length > 0) return { type: 'detonate', coord: mines[0]!.coord }
    return null
  },
}

export const ALL_BOTS: readonly Bot[] = [greedyBot, noHookBot, blindProberBot]
