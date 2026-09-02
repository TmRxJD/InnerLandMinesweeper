/**
 * A reference auto-player used by BOTH the balance harness and the in-game Autoplay, so the run
 * you watch is the same player the harness validates. It is meant to *demonstrate strategy*, not
 * just cascade: it clears the field outward, then runs a deliberate **Boss campaign** — it grooms
 * a "keystone" mine near the centre, pumps its stack via overlapping detonations, and only then
 * delivers that big stack to the Boss (walking it in with a Magnetic Hook if it's out of range).
 * The Boss is blast-only and no longer surrounded by a dense ring, so this build-and-deliver loop
 * is the actual way it dies — the bot can't cheese it.
 */

import { blastRadiusForStack, overlapBoost } from './tuning'
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

/** The one-step direction that pulls `mine` one Chebyshev ring closer to the Boss onto a cell that
 *  isn't the Boss or another live mine, or null if it can't get closer (already Boss-adjacent, or
 *  every inward cell is blocked). Prefers the diagonal (closes both axes), then an orthogonal, then
 *  a diagonal *slide* that keeps the distance but rounds a blocker. This is the packing motion:
 *  run every mine down the gradient toward the Boss and they pile into a tight blob on the ring. */
function stepToward(mine: TileView, target: Coord, snap: BoardSnapshot): Coord | null {
  const sx = Math.sign(target.x - mine.coord.x)
  const sy = Math.sign(target.y - mine.coord.y)
  const cur = cheb(mine.coord, target)
  if (cur === 0) return null // already on the rally
  const cands: Coord[] = []
  if (sx && sy) cands.push({ x: sx, y: sy })
  if (sx) cands.push({ x: sx, y: 0 })
  if (sy) cands.push({ x: 0, y: sy })
  // Sideways slides to get around a mine parked in front.
  if (sx) cands.push({ x: sx, y: 1 }, { x: sx, y: -1 })
  if (sy) cands.push({ x: 1, y: sy }, { x: -1, y: sy })
  for (const d of cands) {
    if (!d.x && !d.y) continue
    const nx = mine.coord.x + d.x
    const ny = mine.coord.y + d.y
    if (Math.max(Math.abs(target.x - nx), Math.abs(target.y - ny)) >= cur) continue // must approach
    const t = snap.tiles[ny * snap.width + nx]
    if (!t || t.tier === 'boss' || t.state === 'armed') continue // blocked by Boss or a live mine
    return d
  }
  return null
}

/** A single Boss-adjacent cell to pile the squad onto — chosen on the side the squad mostly sits, so
 *  the hooks travel least. Mines come from all directions now, so hooking them "toward the Boss"
 *  spreads them thin around the ring where they can't chain; hooking them all toward ONE rally point
 *  packs them into a tight blob that self-charges. */
function rallyPoint(squad: TileView[], boss: Coord): Coord {
  let cx = 0
  let cy = 0
  for (const m of squad) {
    cx += m.coord.x
    cy += m.coord.y
  }
  const dx = Math.sign(cx / squad.length - boss.x) || 1
  const dy = Math.sign(cy / squad.length - boss.y)
  return { x: boss.x + dx, y: boss.y + dy }
}

/** Pack step: hook the squad mine *farthest* from the rally one tile toward it, so the blob fills in
 *  from the rally outward. Null when nothing can move closer (packed) or there are no hooks left. */
function gatherMove(squad: TileView[], boss: Coord, snap: BoardSnapshot): AutoAction | null {
  if (snap.hookCharges < 1 || squad.length === 0) return null
  const rally = rallyPoint(squad, boss)
  let best: { m: TileView; dir: Coord } | null = null
  let bestD = -1
  for (const m of squad) {
    const dir = stepToward(m, rally, snap)
    if (!dir) continue
    const d = cheb(m.coord, rally)
    if (d > bestD) {
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
    // The Boss is chipped one ring beyond the blast too (engine's radius+1 rule): a mine only has
    // to be adjacent to the Boss's tile — not on top of it — to deal its stack.
    const immediate = cheb(m.coord, boss) <= r + 1 ? m.mineCharge ?? 1 : 0
    let potential = 0
    for (const o of near) {
      if (o === m) continue
      // A detonation charges mines one ring beyond its blast too (engine's radius+1 trigger), and the
      // boost scales with THIS mine's stack (overlapBoost) — matching the engine exactly.
      const charged = cheb(m.coord, o.coord) <= r + 1 ? overlapBoost(m.mineCharge ?? 1, snap.overlapBoostPerStack) : 0
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

/** Simulate the greedy chain (same order as chainStarter) on the near mines AS THEY ARE and return
 *  the total damage it would deal to the Boss. Mirrors the engine: radius+1 charge/boss reach and
 *  the stack cap. Used to decide whether the mines already kill the Boss where they sit — if so, the
 *  bot skips gathering (hooks would only cost time). If not, it hooks to tighten the cluster. This is
 *  what makes hooks pay for themselves: they're spent only when the spread chain falls short. */
function predictChainDamage(near: TileView[], boss: Coord, snap: BoardSnapshot): number {
  const sim = near.map(m => ({ x: m.coord.x, y: m.coord.y, s: m.mineCharge ?? 1, alive: true }))
  const ch = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
  let dmg = 0
  for (;;) {
    let bi = -1
    let bs = -Infinity
    for (let i = 0; i < sim.length; i++) {
      const m = sim[i]!
      if (!m.alive) continue
      const r = blastRadiusForStack(m.s, snap.blastRadiusCap)
      let sc = ch(m, boss) <= r + 1 ? m.s : 0
      for (let j = 0; j < sim.length; j++) {
        const o = sim[j]!
        if (j === i || !o.alive) continue
        sc += Math.min(snap.stackCap, o.s + (ch(m, o) <= r + 1 ? overlapBoost(m.s, snap.overlapBoostPerStack) : 0))
      }
      if (sc > bs) {
        bs = sc
        bi = i
      }
    }
    if (bi < 0) break
    const m = sim[bi]!
    const r = blastRadiusForStack(m.s, snap.blastRadiusCap)
    if (ch(m, boss) <= r + 1) dmg += m.s
    for (let j = 0; j < sim.length; j++) {
      const o = sim[j]!
      if (j === bi || !o.alive) continue
      if (ch(m, o) <= r + 1) o.s = Math.min(snap.stackCap, o.s + overlapBoost(m.s, snap.overlapBoostPerStack))
    }
    m.alive = false
  }
  return dmg
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

/** How many of a tile's 8 neighbours are already cleared ground. */
function clearedNeighbourCount(t: TileView, snap: BoardSnapshot): number {
  const w = snap.width
  let n = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const o = snap.tiles[(t.coord.y + dy) * w + (t.coord.x + dx)]
      if (o && (o.state === 'cleared' || o.state === 'detonated')) n++
    }
  }
  return n
}

/** Choose the next tile to uncover with intent instead of scanning rows. Among the frontier (tiles
 *  touching already-cleared ground — so the explored area grows as one connected region, never a
 *  teleporting cursor) prefer the tile boxed in by the MOST cleared neighbours. That fills concave
 *  pockets first and grows the cleared area as a smooth, rounded blob — it reads as a player working
 *  a region rather than a cursor scanning left-to-right — and it's actually *faster* than a row scan,
 *  because a compact front feeds the blast-clears better. (A centre-ward bias was tried and dropped:
 *  it dragged the front inward and slowed the clear badly, especially on the big Hard board.) */
function pickReveal(tappable: TileView[], snap: BoardSnapshot): TileView | null {
  const frontier = tappable.filter(t => hasRevealedNeighbour(t, snap, snap.width))
  const pool = frontier.length > 0 ? frontier : tappable
  return bestBy(pool, t => clearedNeighbourCount(t, snap))
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
 *
 * `opts.useHooks` (default true) toggles phase 2. With it off the bot never hooks — it just chains
 * the mines where they spawned. That is not a real strategy so much as a MEASURING TOOL: running the
 * same player with hooks on vs off tells the balance harness how hook-dependent each difficulty is.
 */
export interface AutoPlayOptions {
  readonly useHooks?: boolean
}

export function autoPlay(snap: BoardSnapshot, opts: AutoPlayOptions = {}): AutoAction | null {
  const useHooks = opts.useHooks ?? true
  if (snap.status !== 'playing') return null
  const mines = armedMines(snap)
  const boss = bossCoord(snap)
  const bossAlive = snap.bossHp > 0
  const tappable = actionable(snap).filter(t => t.tier !== 'boss')

  // ONE scarce pool, budgeted against the ammo counter. The Boss needs ~`need` mines delivered; the
  // rest are `surplus` we can spend clearing (each detonation opens ground AND refuels charge — charge
  // is earned, not regenerated, so the mines must do the clearing). When the surplus runs out we STOP
  // clearing with mines and commit the remainder to the kill — that's what stops us over-spending the
  // pool and losing.
  const need = Math.ceil(Math.sqrt(2 * snap.bossHp)) + 2
  const surplus = snap.minesRemaining - need
  const canHitBoss = (m: TileView): boolean =>
    cheb(m.coord, boss) <= blastRadiusForStack(m.mineCharge ?? 1, snap.blastRadiusCap) + 1
  // The squad = the armed mines nearest the Boss (the deliverables). Prefer spending FAR mines on the
  // field so the near ones stay cheap to hook in.
  const squad = [...mines].sort((a, b) => cheb(a.coord, boss) - cheb(b.coord, boss)).slice(0, need)
  const lethal = squad.length > 0 && predictChainDamage(squad, boss, snap) >= snap.bossHp

  // === Boss delivery. Fire the squad the instant it's lethally gathered; otherwise, once we're out
  //     of surplus, commit to hooking it across the moat. While surplus remains we keep clearing (and
  //     uncovering more near-Boss mines to draft into the squad). ===
  if (bossAlive && squad.length > 0) {
    if (lethal) {
      const starter = chainStarter(squad, boss, snap)
      if (starter && canHitBoss(starter)) return { type: 'detonate', coord: starter.coord }
      if (useHooks && snap.hookCharges >= 1) {
        const g = gatherMove(squad, boss, snap)
        if (g) return g
      }
    } else if (surplus <= 1 && useHooks && snap.hookCharges >= 1) {
      const g = gatherMove(squad, boss, snap) // low on ammo — commit: hook the killers in
      if (g) return g
    }
  }

  // === Clearing (only while surplus mines remain to spend). Prefer detonating a FAR mine (keep near
  //     ones for the squad) that opens the most ground; the blast refuels charge too. ===
  if (surplus > 1) {
    const c = bestBy(mines.filter(m => clearValue(m, snap) > 0), m => clearValue(m, snap) + cheb(m.coord, boss) * 0.4)
    if (c) return { type: 'detonate', coord: c.coord }
  }

  // Tap the frontier to uncover ground / find more mines, while charge allows.
  if (tappable.length > 0 && snap.playerCharge >= 1) {
    const pick = pickReveal(tappable, snap)
    if (pick) return { type: 'reveal', coord: pick.coord }
  }

  // Broke with ground left: no regen — refuel by detonating a mine, IF we still have surplus to spend
  // (prefer a far one). Out of surplus and out of charge → nothing but the squad remains: stuck.
  if (tappable.length > 0 && surplus > 0) {
    const refuel = bestBy(mines, m => clearValue(m, snap) * 2 + (m.mineCharge ?? 1) + cheb(m.coord, boss) * 0.4)
    if (refuel) return { type: 'detonate', coord: refuel.coord }
  }

  // Nothing to clear and the Boss is up: keep hooking the squad into a lethal blob. We NEVER chip the
  // Boss with a squad mine before the whole chain is lethal — a wasted killer is a lost run — so if we
  // can't gather (no hooks) and the chain isn't lethal yet, there's nothing safe to do.
  if (bossAlive && squad.length > 0 && useHooks && snap.hookCharges >= 1) {
    const g = gatherMove(squad, boss, snap)
    if (g) return g
  }

  // Boss DEAD — no reserve to protect any more, so spend every stray mine to finish the last ground.
  // (While the Boss lives we never reach here past the reserve: that would over-spend and lose.)
  if (!bossAlive) {
    const any = bestBy(mines, m => clearValue(m, snap) + (m.mineCharge ?? 1) * 0.1)
    if (any) return { type: 'detonate', coord: any.coord }
  }
  return null
}
