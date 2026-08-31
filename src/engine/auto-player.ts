/**
 * A reference auto-player: a reasonable, non-deducing strategy used by BOTH the balance
 * harness and the in-game watch-demo, so the demo you watch is the same player the harness
 * validates.
 *
 * The model rewards *blasts over taps*: detonating a mine clears its whole square for free and
 * chain-arms the mines it catches, while a hand-tap clears one tile for one charge. So the bot:
 *  - detonates armed mines whenever a blast would clear ground or hit the Boss (this cascades),
 *  - otherwise taps the frontier to open new ground and uncover more mines (free when the tile
 *    is a mine, 1 charge when it's an enemy),
 *  - falls back to detonating anything / waiting for regen when broke.
 * Emergent effect: it clears outward→inward, pumping inner mines via overlap and spending them
 * on the Boss.
 */

import { blastRadiusForStack } from './tuning'
import type { BoardSnapshot, Coord, TileView } from './types'

export interface AutoAction {
  readonly type: 'reveal' | 'detonate'
  readonly coord: Coord
}

const RADIUS_CAP = 3 // matches tuning.blastRadiusCap; the bot's targeting heuristic

function actionable(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'covered' || t.state === 'cracked')
}
function armedMines(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'armed')
}
function cheb(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

/** Value of detonating `mine`: covered ground its (stack-sized) blast would clear, plus a big
 *  bonus for hitting the still-alive Boss, plus other armed mines it would pump. */
function blastValue(mine: TileView, snap: BoardSnapshot): number {
  const radius = blastRadiusForStack(mine.mineCharge ?? 1, RADIUS_CAP)
  let value = 0
  for (const t of snap.tiles) {
    if (t.coord.x === mine.coord.x && t.coord.y === mine.coord.y) continue
    if (cheb(mine.coord, t.coord) > radius) continue
    if (t.state === 'covered' || t.state === 'cracked') value += t.tier === 'boss' ? 20 : 1
    else if (t.state === 'armed') value += 2 // overlap-charges it / chains
  }
  return value + (mine.mineCharge ?? 1) * 0.1
}

function bestMine(mines: TileView[], snap: BoardSnapshot): { mine: TileView; value: number } {
  let best = mines[0]!
  let bestVal = blastValue(best, snap)
  for (const m of mines) {
    const v = blastValue(m, snap)
    if (v > bestVal) {
      best = m
      bestVal = v
    }
  }
  return { mine: best, value: bestVal }
}

function hasRevealedNeighbour(t: TileView, snap: BoardSnapshot, w: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const n = snap.tiles[(t.coord.y + dy) * w + (t.coord.x + dx)]
      if (n && cheb(n.coord, t.coord) === 1 && (n.state === 'cleared' || n.state === 'detonated')) return true
    }
  }
  return false
}

/** One move for the given board, or null if there is nothing useful to do right now. */
export function autoPlay(snap: BoardSnapshot): AutoAction | null {
  if (snap.status !== 'playing') return null
  const mines = armedMines(snap)
  const cov = actionable(snap)
  if (cov.length === 0) {
    // Only armed mines remain — detonate them (they're uncovered, but spend them anyway).
    if (mines.length > 0) return { type: 'detonate', coord: bestMine(mines, snap).mine.coord }
    return null
  }

  // 1. Detonate for free area-clearing whenever a blast actually does something.
  if (mines.length > 0) {
    const { mine, value } = bestMine(mines, snap)
    if (value > 0) return { type: 'detonate', coord: mine.coord }
  }

  // 2. Open new ground / uncover mines. Prefer a covered tile on the cleared frontier so the
  //    board opens contiguously; fall back to any covered tile (e.g. the very first move).
  if (snap.playerCharge >= 1) {
    const frontier = cov.find(t => hasRevealedNeighbour(t, snap, snap.width)) ?? cov[0]!
    return { type: 'reveal', coord: frontier.coord }
  }

  // 3. Broke: detonate any armed mine to refuel and clear; else wait for regen.
  if (mines.length > 0) return { type: 'detonate', coord: bestMine(mines, snap).mine.coord }
  return null
}
