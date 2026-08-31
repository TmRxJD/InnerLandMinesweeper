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

  // 1. Detonate. Two regimes:
  if (mines.length > 0) {
    const boss = { x: (snap.width - 1) / 2 | 0, y: (snap.height - 1) / 2 | 0 }
    const reaches = (m: TileView) => blastRadiusForStack(m.mineCharge ?? 1, RADIUS_CAP) >= cheb(m.coord, boss)
    const usable = mines.filter(m => blastValue(m, snap) > 0)
    if (snap.bossHp > 0 && usable.some(reaches)) {
      // Boss endgame: don't dribble low-stack hits at the Boss. If a mine can kill it, fire.
      const deliveries = usable.filter(reaches).sort((a, b) => (b.mineCharge ?? 1) - (a.mineCharge ?? 1))
      if ((deliveries[0]!.mineCharge ?? 1) >= snap.bossHp) return { type: 'detonate', coord: deliveries[0]!.coord }
      // Otherwise pump the cluster first: detonate the armed mine overlapping the MOST other
      // armed mines (charging them), so a big delivery builds up before it's spent.
      const chargeValue = (m: TileView) => mines.filter(o => o !== m && cheb(o.coord, m.coord) <= blastRadiusForStack(m.mineCharge ?? 1, RADIUS_CAP)).length
      const pump = [...usable].sort((a, b) => chargeValue(b) - chargeValue(a))[0]!
      if (chargeValue(pump) > 0 && !reaches(pump)) return { type: 'detonate', coord: pump.coord }
      // No charger left that spares a delivery — spend the biggest delivery (chip the Boss).
      return { type: 'detonate', coord: deliveries[0]!.coord }
    }
    // Normal: detonate for free area-clearing whenever a blast does something.
    const { mine, value } = bestMine(mines, snap)
    if (value > 0) return { type: 'detonate', coord: mine.coord }
  }

  // 2. Open new ground / uncover mines. The Boss is tap-immune, so never target it (that would
  //    spin uselessly). Prefer a covered tile on the cleared frontier; fall back to any tappable.
  const tappable = cov.filter(t => t.tier !== 'boss')
  if (tappable.length > 0 && snap.playerCharge >= 1) {
    const frontier = tappable.find(t => hasRevealedNeighbour(t, snap, snap.width)) ?? tappable[0]!
    return { type: 'reveal', coord: frontier.coord }
  }

  // 3. Broke: detonate any armed mine to refuel and clear; else wait for regen.
  if (mines.length > 0) return { type: 'detonate', coord: bestMine(mines, snap).mine.coord }
  return null
}
