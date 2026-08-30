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

import type { BoardSnapshot, Coord, TileView } from '../engine/types'

export interface Action {
  readonly type: 'reveal' | 'detonate'
  readonly coord: Coord
}

export interface Bot {
  readonly name: string
  step(snap: BoardSnapshot): Action | null
}

const TIER_COST: Record<TileView['tier'], number> = { light: 1, medium: 3, heavy: 5, elite: 7 }

function covered(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'covered' || t.state === 'cracked')
}

function armed(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'armed')
}

/**
 * A reasonable-but-not-clever player. Clears the cheapest-looking ground first, arms mines
 * as it hits them, and detonates its most-charged mine whenever the pool runs low. This is
 * the proxy for "can a sensible player finish this board?"
 */
export const greedyBot: Bot = {
  name: 'greedy',
  step(snap) {
    const mines = armed(snap)
    const cov = covered(snap)
    if (cov.length === 0) {
      // Only armed mines remain — detonate them to satisfy "all mines uncovered".
      if (mines.length > 0) return { type: 'detonate', coord: mostCharged(mines).coord }
      return null
    }
    cov.sort((a, b) => TIER_COST[a.tier] - TIER_COST[b.tier])
    const cheapest = cov[0]!
    // Can't afford even the cheapest covered tile? Detonate a banked mine rather than
    // chipping — blasts clear tough ground and refill the pool. Only chip when genuinely
    // out of mines (early game), which is what keeps honest cracks rare.
    if (TIER_COST[cheapest.tier] > snap.playerCharge) {
      if (mines.length > 0) return { type: 'detonate', coord: mostCharged(mines).coord }
      return { type: 'reveal', coord: cheapest.coord } // forced chip
    }
    return { type: 'reveal', coord: cheapest.coord }
  },
}

function mostCharged(mines: TileView[]): TileView {
  return mines.reduce((a, b) => ((b.mineCharge ?? 1) > (a.mineCharge ?? 1) ? b : a))
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

export const ALL_BOTS: readonly Bot[] = [greedyBot, blindProberBot]
