/**
 * A reference auto-player: a reasonable, non-deducing strategy that clears the cheapest
 * affordable ground first, arms mines as it hits them, and detonates a banked mine rather
 * than chipping when it can't afford the cheapest tile. It never chips while a mine is
 * banked, which is what keeps its play clean.
 *
 * This is the single shared "brain" used by BOTH the balance harness (as a completability
 * proxy) and the in-game watch-demo. One source, so the demo you watch and the numbers the
 * harness reports come from the same player.
 */

import type { BoardSnapshot, Coord, Tier, TileView } from './types'

export interface AutoAction {
  readonly type: 'reveal' | 'detonate'
  readonly coord: Coord
}

const TIER_COST: Record<Tier, number> = { light: 1, medium: 3, heavy: 5, elite: 7 }

function actionable(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'covered' || t.state === 'cracked')
}
function armedMines(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'armed')
}
function mostCharged(mines: TileView[]): TileView {
  return mines.reduce((a, b) => ((b.mineCharge ?? 1) > (a.mineCharge ?? 1) ? b : a))
}

/** One move for the given board, or null if there is nothing useful left to do. */
export function autoPlay(snap: BoardSnapshot): AutoAction | null {
  if (snap.status !== 'playing') return null
  const mines = armedMines(snap)
  const cov = actionable(snap)
  if (cov.length === 0) {
    if (mines.length > 0) return { type: 'detonate', coord: mostCharged(mines).coord }
    return null
  }
  const cheapest = [...cov].sort((a, b) => TIER_COST[a.tier] - TIER_COST[b.tier])[0]!
  if (TIER_COST[cheapest.tier] > snap.playerCharge) {
    if (mines.length > 0) return { type: 'detonate', coord: mostCharged(mines).coord }
    return { type: 'reveal', coord: cheapest.coord } // forced chip
  }
  return { type: 'reveal', coord: cheapest.coord }
}
