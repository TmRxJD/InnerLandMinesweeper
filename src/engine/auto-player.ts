/**
 * A reference auto-player: a reasonable, non-deducing strategy used by BOTH the balance
 * harness and the in-game watch-demo, so the demo you watch is the same player the harness
 * validates.
 *
 * Rules it plays by (mirrors the engine):
 *  - Only Common tiles can be cleared by tapping; tougher tiles are shielded and need a mine
 *    blast to reduce their HP. So the player taps Commons (clearing ground or arming mines)
 *    and detonates mines to clear the tough tiles — aiming each blast where the tough tiles
 *    (and other mines) are densest.
 */

import type { BoardSnapshot, Coord, TileView } from './types'

export interface AutoAction {
  readonly type: 'reveal' | 'detonate'
  readonly coord: Coord
}

const BLAST_RADIUS = 2 // matches tuning; the bot's targeting heuristic

function actionable(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'covered' || t.state === 'cracked')
}
function armedMines(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'armed')
}
function cheb(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

/** Value of detonating `mine`: how much tough/uncleared ground and how many other mines its
 *  blast would touch — plus its charge as a tiebreaker for a bigger blast. */
function blastValue(mine: TileView, snap: BoardSnapshot): number {
  let value = 0
  for (const t of snap.tiles) {
    if (t.coord.x === mine.coord.x && t.coord.y === mine.coord.y) continue
    if (cheb(mine.coord, t.coord) > BLAST_RADIUS) continue
    if (t.state === 'covered' || t.state === 'cracked') {
      value += t.tier === 'common' ? 1 : 3 // tough tiles are the whole point of blasting
    } else if (t.state === 'armed') {
      value += 2 // overlap charges it / chains
    }
  }
  return value + (mine.mineCharge ?? 1) * 0.1
}

function bestMine(mines: TileView[], snap: BoardSnapshot): TileView {
  return mines.reduce((best, m) => (blastValue(m, snap) > blastValue(best, snap) ? m : best))
}

/** One move for the given board, or null if there is nothing useful left to do. */
export function autoPlay(snap: BoardSnapshot): AutoAction | null {
  if (snap.status !== 'playing') return null
  const mines = armedMines(snap)
  const cov = actionable(snap)
  if (cov.length === 0) {
    // Only armed mines remain — detonate them to satisfy "all mines uncovered".
    if (mines.length > 0) return { type: 'detonate', coord: bestMine(mines, snap).coord }
    return null
  }

  // Tap the cheapest affordable Common (clears ground or arms a hidden mine).
  const commons = cov.filter(t => t.tier === 'common')
  if (commons.length > 0 && snap.playerCharge >= 1) return { type: 'reveal', coord: commons[0]!.coord }

  // Otherwise detonate a mine to clear tough ground (and refuel + chain-arm).
  if (mines.length > 0) return { type: 'detonate', coord: bestMine(mines, snap).coord }

  // No mines: grind the Boss by tapping if we can pay for a hit.
  const boss = cov.find(t => t.tier === 'boss')
  if (boss && snap.playerCharge >= 1) return { type: 'reveal', coord: boss.coord }

  // Last resort: tap something to make progress (a Common if any — chips/arms a mine).
  if (commons.length > 0) return { type: 'reveal', coord: commons[0]!.coord }
  return { type: 'reveal', coord: cov[0]!.coord }
}
