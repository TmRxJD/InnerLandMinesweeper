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

/** A mine is "near" the Boss — a killer we gather into the blob — if it could reach the Boss with
 *  a modest stack. Anything further is field ordnance, spent only to clear ground. */
function isNear(mine: TileView, boss: Coord, snap: BoardSnapshot): boolean {
  return cheb(mine.coord, boss) <= snap.gatherRadius
}

/** The one-step direction that pulls `mine` one Chebyshev ring closer to the Boss onto a cell that
 *  isn't the Boss or another live mine, or null if it can't get closer (already Boss-adjacent, or
 *  every inward cell is blocked). Prefers the diagonal (closes both axes), then an orthogonal, then
 *  a diagonal *slide* that keeps the distance but rounds a blocker. This is the packing motion:
 *  run every mine down the gradient toward the Boss and they pile into a tight blob on the ring. */
function stepTowardBoss(mine: TileView, boss: Coord, snap: BoardSnapshot): Coord | null {
  const sx = Math.sign(boss.x - mine.coord.x)
  const sy = Math.sign(boss.y - mine.coord.y)
  const cur = cheb(mine.coord, boss)
  if (cur <= 1) return null // already Boss-adjacent — as packed as it gets
  const cands: Coord[] = []
  if (sx && sy) cands.push({ x: sx, y: sy })
  if (sx) cands.push({ x: sx, y: 0 })
  if (sy) cands.push({ x: 0, y: sy })
  // Sideways slides (same inward axis, either cross step) to get around a mine parked in front.
  if (sx) cands.push({ x: sx, y: 1 }, { x: sx, y: -1 })
  if (sy) cands.push({ x: 1, y: sy }, { x: -1, y: sy })
  for (const d of cands) {
    if (!d.x && !d.y) continue
    const nx = mine.coord.x + d.x
    const ny = mine.coord.y + d.y
    const nc = Math.max(Math.abs(boss.x - nx), Math.abs(boss.y - ny))
    if (nc < 1 || nc > cur) continue // never onto the Boss, never further out
    const t = snap.tiles[ny * snap.width + nx]
    if (!t || t.tier === 'boss' || t.state === 'armed') continue // blocked by Boss or a live mine
    return d
  }
  return null
}

/** Pack step: hook the near mine that is *farthest* from the Boss one ring inward. Bringing outer
 *  mines in first fills the Boss-adjacent cells and leaves a dense blob. Null when nothing can move
 *  closer (fully packed) or there are no hooks left — either way it's time to chain. */
function gatherMove(near: TileView[], boss: Coord, snap: BoardSnapshot): AutoAction | null {
  if (snap.hookCharges < 1) return null
  let best: { m: TileView; dir: Coord } | null = null
  let bestD = 1
  for (const m of near) {
    const dir = stepTowardBoss(m, boss, snap)
    if (!dir) continue
    const d = cheb(m.coord, boss)
    if (d > bestD || !best) {
      best = { m, dir }
      bestD = d
    }
  }
  return best ? { type: 'hook', coord: best.m.coord, dir: best.dir } : null
}

/** Which packed mine to detonate next. This is the heart of the chain, and the order is what makes
 *  or breaks the kill: a naive "spend chargers first" order delivers ~2.3× the mine count, but a
 *  one-ply greedy on the RIGHT objective delivers ~5× — nearly the beam-searched optimum.
 *
 *  Objective: for each candidate, score = (boss damage it deals right now) + (total stack left on
 *  the board afterwards). Maximising that jointly cashes in a mine while it is Boss-ready and keeps
 *  the surviving blob as charged as possible — the greedy naturally fires out-of-range mines to pump
 *  the core, then unloads the fattened core into the Boss. Verified in .scratch/sim.ts against a
 *  beam search: 56/59 (standard), 63/66 (hard). */
function chainStarter(near: TileView[], boss: Coord, snap: BoardSnapshot): TileView | null {
  let best: TileView | null = null
  let bestScore = -Infinity
  for (const m of near) {
    const r = blastRadiusForStack(m.mineCharge ?? 1, snap.blastRadiusCap)
    const immediate = cheb(m.coord, boss) <= r ? m.mineCharge ?? 1 : 0
    let potential = 0
    for (const o of near) {
      if (o === m) continue
      const charged = cheb(m.coord, o.coord) <= r ? 1 : 0
      potential += Math.min(snap.stackCap, (o.mineCharge ?? 1) + charged)
    }
    const score = immediate + potential
    if (score > bestScore) {
      bestScore = score
      best = m
    }
  }
  return best
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

/** One move for the given board, or null if there is nothing useful to do right now.
 *
 * The strategy is three phases, in priority order:
 *   1. CLEAR the field outward — reveal frontier tiles (which also arms the near-Boss mines) and
 *      detonate *far* ordnance to open ground and earn Hook charges. The near-Boss killers are
 *      spared; they are never spent on ground.
 *   2. GATHER — once the field is clear, hook the near-Boss mines down the gradient into a tight
 *      blob on the Boss ring. The minimal, no-touching spawn can't kill the Boss until this packs
 *      them, so this is the earned skill the board is built around.
 *   3. CHAIN — detonate the packed blob in escalating order (cheap chargers first) so it self-
 *      charges past the Boss's HP.
 */
export function autoPlay(snap: BoardSnapshot): AutoAction | null {
  if (snap.status !== 'playing') return null
  const mines = armedMines(snap)
  const boss = bossCoord(snap)
  const bossAlive = snap.bossHp > 0
  const tappable = actionable(snap).filter(t => t.tier !== 'boss')
  const near = mines.filter(m => isNear(m, boss, snap))
  const far = mines.filter(m => !isNear(m, boss, snap))

  // === Phase 1: clear/arm the field. Detonate FAR ordnance to open ground; reveal the frontier. ===
  // The near-Boss killers are NEVER spent here — they're saved for the blob. Crucially, we do not
  // start the Boss campaign until the field is fully clear: touching the near mines early (e.g. while
  // broke, before they're gathered and charged) dumps them at stack 1 and throws away the win.
  const farClearers = far.filter(m => clearValue(m, snap) > 0)
  const c = bestBy(farClearers, m => clearValue(m, snap))
  if (c) return { type: 'detonate', coord: c.coord }

  if (tappable.length > 0) {
    // Still ground to clear. Reveal if we can afford it; otherwise wait for charge to regen —
    // do NOT raid the near mines to make a move.
    if (snap.playerCharge >= 1) {
      const frontier = tappable.find(t => hasRevealedNeighbour(t, snap, snap.width)) ?? tappable[0]!
      return { type: 'reveal', coord: frontier.coord }
    }
    return null // broke — regen will let us keep clearing next tick
  }

  // === Field is clear. Phases 2 & 3: gather the near mines into a blob, then chain it. ===
  if (bossAlive && near.length > 0) {
    const gather = gatherMove(near, boss, snap) // Phase 2: pack
    if (gather) return gather
    const starter = chainStarter(near, boss, snap) // Phase 3: escalating detonation
    if (starter) return { type: 'detonate', coord: starter.coord }
  }

  // Boss already dead but armed mines linger — spend them to finish clearing any last ground.
  const any = bestBy(mines, m => clearValue(m, snap) + (m.mineCharge ?? 1) * 0.1)
  if (any && (clearValue(any, snap) > 0 || !bossAlive)) return { type: 'detonate', coord: any.coord }

  return null // nothing affordable — wait for charge to regen
}
