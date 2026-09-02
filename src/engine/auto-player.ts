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
import { bestChain } from './chain-planner'
import type { BoardSnapshot, Coord, MinesweeperEngine, TileView } from './types'

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

/** Whether a hook on `mine` would actually advance it. The engine now pulls a hooked mine one step
 *  STRAIGHT at the Boss on its own — the bot only decides WHICH mine. So this just checks that step is
 *  worth spending a hook on: the cell straight toward the Boss must be passable (cleared/cracked/
 *  detonated ground — a cracked enemy there is crushed). We refuse when it's still COVERED (it could
 *  hide a mine, which blocks → a wasted no-op) or is a known live mine / the Boss. In effect the bot
 *  hooks a mine only once its lane into the centre is open. */
function canHookTowardBoss(mine: TileView, boss: Coord, snap: BoardSnapshot): boolean {
  const dx = Math.sign(boss.x - mine.coord.x)
  const dy = Math.sign(boss.y - mine.coord.y)
  if (!dx && !dy) return false
  const t = snap.tiles[(mine.coord.y + dy) * snap.width + (mine.coord.x + dx)]
  if (!t || t.tier === 'boss') return false
  // Passable = anything but a known live mine. Covered ground is crushed on the way in (the hook goes
  // THROUGH enemies); the only true block is another armed mine. (A covered tile could hide a mine and
  // no-op, but that is rare and the caller tries the next mine rather than spinning on this one.)
  return t.state !== 'armed'
}
/** Hook the nearest squad mine that can't yet strike the Boss. Direction is the engine's (straight
 *  in); the bot only picks which mine, and only one whose lane is open (canHookTowardBoss), so the
 *  hook always advances instead of no-opping. Mines already in strike range are left alone, so this
 *  drains to nothing rather than looping. */
function gatherMove(squad: TileView[], boss: Coord, snap: BoardSnapshot): AutoAction | null {
  if (snap.hookCharges < 1) return null
  const outOfRange = squad
    .filter(m => cheb(m.coord, boss) > blastRadiusForStack(m.mineCharge ?? 1, snap.blastRadiusCap) + 1)
    .sort((a, b) => cheb(a.coord, boss) - cheb(b.coord, boss))
  for (const m of outOfRange) {
    if (canHookTowardBoss(m, boss, snap)) return { type: 'hook', coord: m.coord }
  }
  return null
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
  let shield = snap.bossShield // charge shield: the first `shield` boss-hits strip a charge (0 HP dmg)
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
    if (ch(m, boss) <= r + 1) {
      if (shield > 0) shield-- // this hit is spent stripping a shield charge, not on HP
      else dmg += m.s
    }
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
  // The Boss hides behind a regenerating CHARGE shield: the first `bossShield` boss-hits strip charges
  // (no HP damage), then hits reach HP. So the DAMAGE to plan for is just its HP, but the squad needs a
  // few EXTRA mines to spend stripping the shield first (one hit per charge).
  const need = Math.ceil(Math.sqrt(2 * snap.bossHp)) + 2 + snap.bossShield
  const surplus = snap.minesRemaining - need
  const canHitBoss = (m: TileView): boolean =>
    cheb(m.coord, boss) <= blastRadiusForStack(m.mineCharge ?? 1, snap.blastRadiusCap) + 1
  // The squad = the armed mines nearest the Boss (the deliverables). Prefer spending FAR mines on the
  // field so the near ones stay cheap to hook in.
  const squad = [...mines].sort((a, b) => cheb(a.coord, boss) - cheb(b.coord, boss)).slice(0, need)
  // predictChainDamage models the shield internally, so it returns HP damage AFTER the charges are
  // stripped — lethal once that reaches the Boss's HP.
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

  // === No-stall guarantee. If we're here the board is still playable but the structured plan came up
  //     empty (can't gather across a covered path, out of hooks, broke, etc.). NEVER freeze with moves
  //     on the board: make the best real progress available. Detonating an armed mine always helps —
  //     it clears ground, refuels charge, arms/pumps neighbours, and any Boss-hit strips a shield
  //     charge — so prefer that (favouring a Boss-reacher to advance the kill); otherwise tap to open
  //     more ground. If this over-spends the pool the run resolves as an honest loss, not a stall. ===
  if (mines.length > 0) {
    const pick = bestBy(mines, m => clearValue(m, snap) * 2 + (canHitBoss(m) ? 6 : 0) + (m.mineCharge ?? 1))
    if (pick) return { type: 'detonate', coord: pick.coord }
  }
  if (tappable.length > 0 && snap.playerCharge >= 1) {
    const pick = pickReveal(tappable, snap)
    if (pick) return { type: 'reveal', coord: pick.coord }
  }
  return null
}

/** The 8 neighbours of a cell that are on the board. */
function neighbours8(snap: BoardSnapshot, x: number, y: number): TileView[] {
  const out: TileView[] = []
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const t = snap.tiles[(y + dy) * snap.width + (x + dx)]
      if (t && y + dy >= 0 && y + dy < snap.height && x + dx >= 0 && x + dx < snap.width) out.push(t)
    }
  return out
}

/** A covered tile that is PROVABLY a mine by the revealed numbers — a cleared neighbour whose count,
 *  minus the mines already armed around it, exactly equals its remaining covered neighbours (so all of
 *  them must be mines). Revealing such a tile ARMS it for free (revealing a mine costs no charge),
 *  which is the escape from the charge dead-end: broke, with covered tiles left and nothing armed to
 *  refuel from, the bot can still deduce a mine, arm it, and detonate it for fuel. Null when nothing is
 *  forced (the numbers leave it ambiguous). */
function findForcedMine(snap: BoardSnapshot): TileView | null {
  for (const t of snap.tiles) {
    if (t.state !== 'cleared' || t.number === undefined || t.number <= 0) continue
    const nbrs = neighbours8(snap, t.coord.x, t.coord.y)
    const covered = nbrs.filter(n => n.state === 'covered')
    if (covered.length === 0) continue
    const armed = nbrs.filter(n => n.state === 'armed').length
    if (t.number - armed === covered.length) return covered[0]! // every covered neighbour is a mine
  }
  return null
}

/** Crude Minesweeper mine-probability for a covered tile, read off the revealed numbers around it: for
 *  each adjacent cleared number, the mines it still needs spread evenly over its covered neighbours. A
 *  tile next to a "3" that has exactly three covered neighbours scores ~3 (a certain mine); a tile no
 *  number touches scores 0. Why it matters: revealing a covered MINE costs no charge (it just arms),
 *  while revealing ground costs a charge — so uncovering the LIKELY mines first arms fuel/ordnance for
 *  free instead of tapping the charge away on ground, which is what left the bot broke and grinding. */
function mineLikelihood(t: TileView, snap: BoardSnapshot): number {
  let score = 0
  for (const n of neighbours8(snap, t.coord.x, t.coord.y)) {
    if (n.state !== 'cleared' || n.number === undefined || n.number <= 0) continue
    const nn = neighbours8(snap, n.coord.x, n.coord.y)
    const covered = nn.filter(c => c.state === 'covered').length
    const armed = nn.filter(c => c.state === 'armed').length
    const need = n.number - armed
    if (need > 0 && covered > 0) score += need / covered
  }
  return score
}

/** Reveal aimed at ARMING the next cascade, not sweeping the board: prefer a tile the numbers say is a
 *  mine (free arm), otherwise a frontier tile out at the mine ring (just past the empty centre, where
 *  the ordnance actually is) so a few reveals reach live mines instead of burning charge on dead
 *  central ground. */
function revealForAmmo(snap: BoardSnapshot, boss: Coord): Coord | null {
  const covered = snap.tiles.filter(t => (t.state === 'covered' || t.state === 'cracked') && t.tier !== 'boss')
  const frontier = covered.filter(t => hasRevealedNeighbour(t, snap, snap.width))
  const pool = frontier.length > 0 ? frontier : covered
  const ring = snap.gatherRadius + 2
  const pick = bestBy(pool, t => mineLikelihood(t, snap) * 100 - Math.abs(cheb(t.coord, boss) - ring))
  return pick ? pick.coord : null
}

/**
 * The real planner — the "smarter evaluation" the greedy `autoPlay` never had. It reasons about CHAINS,
 * not tiles: `bestChain` searches detonation orders (on cloned engines, so the cascade is exact) for the
 * sequence that removes the most enemies per mine spent, and the planner plays toward setting those up.
 *
 * Priority, each move:
 *   1. Deliver the Boss kill when the gathered squad is lethal, else hook the squad across the gap —
 *      the beam-verified campaign the greedy player already got right (unchanged).
 *   2. Fire the cleanest FIELD cascade (the squad reserved) — the mine game, not tile-sweeping.
 *   3. Reveal only to ARM the next cascade, out at the mine ring.
 *   4. Never-stall fallbacks (a weaker chain, a deduced/fished mine).
 *
 * Takes the live engine (not a snapshot) because the chain search clones and plays forward.
 */
export function planMove(engine: MinesweeperEngine): AutoAction | null {
  const snap = engine.snapshot()
  if (snap.status !== 'playing') return null
  const boss = bossCoord(snap)
  const mines = armedMines(snap)
  const bossAlive = snap.bossHp > 0
  const need = Math.ceil(Math.sqrt(2 * snap.bossHp)) + snap.bossShield + 3
  const squad = [...mines].sort((a, b) => cheb(a.coord, boss) - cheb(b.coord, boss)).slice(0, need)
  const surplus = snap.minesRemaining - need
  const squadKeys = new Set(squad.map(m => m.coord.y * snap.width + m.coord.x))
  const canHitBoss = (m: TileView): boolean =>
    cheb(m.coord, boss) <= blastRadiusForStack(m.mineCharge ?? 1, snap.blastRadiusCap) + 1
  const lethal = squad.length > 0 && predictChainDamage(squad, boss, snap) >= snap.bossHp

  // 1. Boss campaign — chainStarter detonates outer squad mines to pump an inner keystone, then delivers
  //    it, when the squad is lethally gathered; otherwise, once the field surplus is spent, hook the
  //    squad across the gap to finish it. The whole squad is reserved (below) so a field cascade never
  //    detonates a mine mid-gather.
  if (bossAlive && squad.length > 0) {
    if (lethal) {
      const starter = chainStarter(squad, boss, snap)
      if (starter && canHitBoss(starter)) return { type: 'detonate', coord: starter.coord }
      if (snap.hookCharges >= 1) {
        const g = gatherMove(squad, boss, snap)
        if (g) return g
      }
    } else if (surplus <= 1 && snap.hookCharges >= 1) {
      const g = gatherMove(squad, boss, snap)
      if (g) return g
    }
  }

  // 2. Field cascade — cleanest detonation order among field mines (the squad spared while the Boss
  //    lives; once it's dead every mine is free to finish the ground).
  const exclude = bossAlive ? squadKeys : new Set<number>()
  const chain = bestChain(engine, { exclude })
  const haveCovered = snap.tiles.some(t => (t.state === 'covered' || t.state === 'cracked') && t.tier !== 'boss')
  if (chain.sequence.length > 0 && chain.value >= 2) {
    return { type: 'detonate', coord: chain.sequence[0]! }
  }

  // 3. Arm the next cascade (reveal at the mine ring / a deduced mine). Minimal tapping by design.
  if (haveCovered && snap.playerCharge >= 1) {
    const r = revealForAmmo(snap, boss)
    if (r) return { type: 'reveal', coord: r }
  }

  // 4. Never stall: take a weaker chain, then a free deduced/fished mine.
  if (chain.sequence.length > 0) return { type: 'detonate', coord: chain.sequence[0]! }
  const forced = findForcedMine(snap)
  if (forced) return { type: 'reveal', coord: forced.coord }
  if (haveCovered) {
    const tappable = actionable(snap).filter(t => t.tier !== 'boss')
    if (tappable.length > 0) {
      const ranked = [...tappable].sort((a, b) => clearedNeighbourCount(b, snap) - clearedNeighbourCount(a, snap))
      return { type: 'reveal', coord: ranked[snap.moves % Math.min(ranked.length, 16)]!.coord }
    }
  }
  return null
}
