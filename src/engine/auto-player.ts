/**
 * A reference auto-player used by BOTH the balance harness and the in-game Autoplay, so the run
 * you watch is the same player the harness validates. It is meant to *demonstrate strategy*, not
 * just cascade: it clears the field outward, then runs a deliberate **Boss campaign** — it grooms
 * a "keystone" mine near the centre, pumps its stack via overlapping detonations, and only then
 * delivers that big stack to the Boss (walking it in with a Magnetic Hook if it's out of range).
 * The Boss is blast-only and no longer surrounded by a dense ring, so this build-and-deliver loop
 * is the actual way it dies — the bot can't cheese it.
 */

import { blastRadiusForStack } from './tuning'
import type { BoardSnapshot, Coord, TileView } from './types'

export interface AutoAction {
  readonly type: 'reveal' | 'detonate' | 'hook'
  readonly coord: Coord
  /** For a 'hook' action: the one-step direction to pull the mine. */
  readonly dir?: Coord
}

function actionable(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'covered' || t.state === 'cracked')
}
function armedMines(snap: BoardSnapshot): TileView[] {
  return snap.tiles.filter(t => t.state === 'armed')
}
function cheb(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}
function bossCoord(snap: BoardSnapshot): Coord {
  return { x: (snap.width - 1) / 2 | 0, y: (snap.height - 1) / 2 | 0 }
}
function reaches(mine: TileView, boss: Coord, snap: BoardSnapshot): boolean {
  return blastRadiusForStack(mine.mineCharge ?? 1, snap.blastRadiusCap) >= cheb(mine.coord, boss)
}

/** How much covered ground a detonation would clear (its own value as a board-clearer). */
function clearValue(mine: TileView, snap: BoardSnapshot): number {
  const radius = blastRadiusForStack(mine.mineCharge ?? 1, snap.blastRadiusCap)
  let value = 0
  for (const t of snap.tiles) {
    if (t.coord.x === mine.coord.x && t.coord.y === mine.coord.y) continue
    if (cheb(mine.coord, t.coord) > radius) continue
    if ((t.state === 'covered' || t.state === 'cracked') && t.tier !== 'boss') value += 1
    else if (t.state === 'armed') value += 1 // overlap-charges it / chains
  }
  return value
}

function bestBy(mines: TileView[], score: (m: TileView) => number): TileView | null {
  let best: TileView | null = null
  let bestVal = -Infinity
  for (const m of mines) {
    const v = score(m)
    if (v > bestVal) { best = m; bestVal = v }
  }
  return best
}

/** The one-step direction to hook `mine` toward the Boss onto guaranteed-empty ground (so the
 *  charge is never wasted), or null if no such step. Tries the dominant axis, then the other. */
function hookDirToward(mine: TileView, boss: Coord, snap: BoardSnapshot): Coord | null {
  const sx = Math.sign(boss.x - mine.coord.x)
  const sy = Math.sign(boss.y - mine.coord.y)
  const xFirst = Math.abs(boss.x - mine.coord.x) >= Math.abs(boss.y - mine.coord.y)
  const dirs = xFirst ? [{ x: sx, y: 0 }, { x: 0, y: sy }] : [{ x: 0, y: sy }, { x: sx, y: 0 }]
  for (const d of dirs) {
    if (!d.x && !d.y) continue
    const t = snap.tiles[(mine.coord.y + d.y) * snap.width + (mine.coord.x + d.x)]
    if (t && t.tier !== 'boss' && (t.state === 'cleared' || t.state === 'detonated' || t.state === 'cracked')) return d
  }
  return null
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

/** The mine we're grooming for the Boss: the armed mine nearest the centre, then biggest stack. */
function keystoneMine(mines: TileView[], boss: Coord): TileView | null {
  if (mines.length === 0) return null
  return [...mines].sort(
    (a, b) => cheb(a.coord, boss) - cheb(b.coord, boss) || (b.mineCharge ?? 1) - (a.mineCharge ?? 1),
  )[0]!
}

/** One move for the given board, or null if there is nothing useful to do right now. */
export function autoPlay(snap: BoardSnapshot): AutoAction | null {
  if (snap.status !== 'playing') return null
  const mines = armedMines(snap)
  const cov = actionable(snap)
  const boss = bossCoord(snap)
  const bossAlive = snap.bossHp > 0

  if (cov.length === 0) {
    // Field cleared — only the Boss (and maybe mines) remain. Spend mines on it, biggest first.
    const best = bestBy(mines, m => (reaches(m, boss, snap) ? 100 : 0) + (m.mineCharge ?? 1))
    return best ? { type: 'detonate', coord: best.coord } : null
  }

  // === Boss campaign: build a keystone stack near the centre, then deliver it. ===
  const keystone = keystoneMine(mines, boss)
  // Only run the campaign once a mine is near enough that it (or a hook or two) can reach the Boss.
  if (bossAlive && keystone && cheb(keystone.coord, boss) <= snap.blastRadiusCap + 3) {
    const ks = keystone.mineCharge ?? 1
    const wantStack = Math.min(snap.stackCap, 5) // groom a meaty stack before spending it

    // Pump the keystone: detonate an armed mine whose blast overlaps it (that's +1 to its stack).
    if (ks < wantStack) {
      const pumpers = mines.filter(
        m => m !== keystone && cheb(m.coord, keystone.coord) <= blastRadiusForStack(m.mineCharge ?? 1, snap.blastRadiusCap),
      )
      // Prefer a pumper that also clears the most ground and isn't itself a Boss-ready delivery.
      const p = bestBy(pumpers, m => clearValue(m, snap) + (reaches(m, boss, snap) ? -5 : 0))
      if (p) return { type: 'detonate', coord: p.coord }
    }

    // Keystone is grown (or can't be pumped further): deliver it.
    if (reaches(keystone, boss, snap)) return { type: 'detonate', coord: keystone.coord }
    const dir = snap.hookCharges > 0 ? hookDirToward(keystone, boss, snap) : null
    if (dir) return { type: 'hook', coord: keystone.coord, dir }
    // Out of range and no hook lane yet — fall through to clear a path toward the centre.
  }

  // === Clear the field. Detonate a mine that opens ground; while the Boss lives, spare the keystone. ===
  const clearers = mines.filter(m => m !== (bossAlive ? keystone : null) && clearValue(m, snap) > 0)
  const c = bestBy(clearers, m => clearValue(m, snap))
  if (c) return { type: 'detonate', coord: c.coord }

  // Open new ground / uncover mines. Never tap the Boss (it's immune → would spin).
  const tappable = cov.filter(t => t.tier !== 'boss')
  if (tappable.length > 0 && snap.playerCharge >= 1) {
    const frontier = tappable.find(t => hasRevealedNeighbour(t, snap, snap.width)) ?? tappable[0]!
    return { type: 'reveal', coord: frontier.coord }
  }

  // Broke / nothing else: spend any mine (refuel + clear, or chip the Boss); else wait for regen.
  const any = bestBy(mines, m => clearValue(m, snap) + (m.mineCharge ?? 1) * 0.1)
  return any ? { type: 'detonate', coord: any.coord } : null
}
