/**
 * A genuine planning AI for Inner Land Minesweeper — Monte Carlo Tree Search.
 *
 * This is not a rulebook. Given the live position it *searches*: it clones the game, plays out many
 * possible futures, and lets the move choice emerge from which futures actually turn out well. Over
 * an iteration budget it grows a tree of the promising lines (UCB1 balances trying the current best
 * against exploring alternatives), evaluates each leaf by playing it forward, and folds the results
 * back up. The randomness in exploration and in the playouts means it reasons afresh every time — the
 * same board is not played the same way twice, and good moves are discovered, not scripted.
 *
 * The heuristic `autoPlay` is used only as the *playout policy* (a fast way to finish a hypothetical
 * game so it can be scored) — the decisions themselves come from the search, exactly as classic MCTS
 * game engines use a rollout policy under a real tree search.
 */

import type { BoardSnapshot, Coord, MinesweeperEngine, TileView } from './types'
import { autoPlay, type AutoAction } from './auto-player'
import { blastRadiusForStack } from './tuning'

export interface MctsOptions {
  /** Search budget: how many futures to simulate before committing to a move. More = stronger and
   *  more considered, but slower. */
  readonly iterations?: number
  /** Wall-clock budget in ms. When set, the search runs futures until this elapses (min one), which
   *  caps per-move latency for a responsive live demo regardless of difficulty. Overrides
   *  `iterations` as the stopping rule; `iterations` still bounds it so it can't spin unbounded. */
  readonly timeBudgetMs?: number
  /** Exploration constant in UCB1. Higher widens the search (more varied, less greedy). */
  readonly explore?: number
  /** How many frontier reveals to consider at a node (the rest of the action space — detonations,
   *  hooks — is small and kept whole). Bounds the branching so the budget searches deeper. */
  readonly revealSamples?: number
  /** Hard cap on a single playout's length, so a pathological line can't run forever. */
  readonly rolloutCap?: number
  /** Randomness source in [0,1). Defaults to Math.random — pass a seeded one for reproducible runs. */
  readonly rng?: () => number
}

const DEFAULTS = {
  iterations: 60,
  explore: 1.3,
  revealSamples: 8,
  rolloutCap: 24, // short: let the rich evaluation (not 90 moves of playout) decide the move
} as const

/** Game-time charged per action in playouts — matches the balance harness so the AI optimises the
 *  same clock the player races. */
const SECONDS_PER_MOVE = 0.45

const now = (): number =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()

const cheb = (a: Coord, b: Coord): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
const bossOf = (s: BoardSnapshot): Coord => ({ x: (s.width - 1) >> 1, y: (s.height - 1) >> 1 })

function applyAction(engine: MinesweeperEngine, a: AutoAction): void {
  if (a.type === 'reveal') engine.reveal(a.coord)
  else if (a.type === 'hook') engine.useHook(a.coord, a.dir ?? { x: 0, y: 0 })
  else engine.detonate(a.coord)
}

/** The moves worth *considering* from a state — the legal action space the search chooses within.
 *
 *  Mines are one scarce pool: any armed mine can be detonated (to clear + refuel, or to chip the
 *  Boss), and the mines nearest the Boss can be HOOKED toward it to cross the moat and land the kill.
 *  Frontier taps are offered while there's charge to spend. The search decides WHICH — which mine to
 *  spend clearing vs. save, which to hook in and when — and the loss/win reward teaches it that
 *  over-clearing dooms the run. Nothing is phase-gated: the whole game space is on the table. */
function candidateActions(snap: BoardSnapshot, revealSamples: number, rng: () => number): AutoAction[] {
  if (snap.status !== 'playing') return []
  const out: AutoAction[] = []
  const boss = bossOf(snap)
  const armed = snap.tiles.filter(t => t.state === 'armed')

  for (const m of armed) out.push({ type: 'detonate', coord: m.coord })

  // Hooks: a mine is ONLY ever pulled TOWARD the Boss, and only a mine that can't already strike it —
  // so every hook is real delivery progress. Three guarantees kill the dumb behaviour you can watch:
  //   1. strictly CLOSER (Chebyshev must drop) → never sideways, never away, and never oscillating
  //      (a monotonic distance can't return a mine to a square it left);
  //   2. only mines OUT of strike range → it stops fiddling with mines already gathered;
  //   3. KNOWN-EMPTY destination (cleared/cracked/crater) → never a no-op into a live mine/Boss/edge
  //      (a no-op would be re-picked forever by the deterministic search).
  // One hook offered per mine (the best toward-Boss step), so the search picks WHICH mine to advance.
  const w0 = snap.width
  const cb = (x: number, y: number): number => Math.max(Math.abs(x - boss.x), Math.abs(y - boss.y))
  const emptyAt = (x: number, y: number): boolean => {
    const t = snap.tiles[y * w0 + x]
    if (!t || t.tier === 'boss') return false
    return t.state === 'cleared' || t.state === 'cracked' || t.state === 'detonated'
  }
  if (snap.hookCharges >= 1) {
    const strike = snap.blastRadiusCap + 1
    const outOfRange = armed
      .filter(m => cb(m.coord.x, m.coord.y) > strike)
      .sort((a, b) => cb(a.coord.x, a.coord.y) - cb(b.coord.x, b.coord.y))
      .slice(0, 6)
    for (const m of outOfRange) {
      const sx = Math.sign(boss.x - m.coord.x)
      const sy = Math.sign(boss.y - m.coord.y)
      const cur = cb(m.coord.x, m.coord.y)
      // diagonal first (closes both axes), then the two orthogonals — each strictly approaches
      for (const d of [{ x: sx, y: sy }, { x: sx, y: 0 }, { x: 0, y: sy }]) {
        if (!d.x && !d.y) continue
        const nx = m.coord.x + d.x
        const ny = m.coord.y + d.y
        if (cb(nx, ny) >= cur) continue // must get closer to the Boss
        if (emptyAt(nx, ny)) {
          out.push({ type: 'hook', coord: m.coord, dir: d })
          break // one good toward-Boss hook per mine
        }
      }
    }
  }

  if (snap.playerCharge >= 1) {
    const w = snap.width
    const covered = snap.tiles.filter(t => (t.state === 'covered' || t.state === 'cracked') && t.tier !== 'boss')
    const hasRevealedNeighbour = (t: TileView): boolean => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const n = snap.tiles[(t.coord.y + dy) * w + (t.coord.x + dx)]
          if (n && (n.state === 'cleared' || n.state === 'detonated')) return true
        }
      return false
    }
    const frontier = covered.filter(hasRevealedNeighbour)
    const pool = frontier.length > 0 ? frontier : covered
    for (const t of sample(pool, revealSamples, rng)) out.push({ type: 'reveal', coord: t.coord })
  }
  return out
}


/** A random subset of `k` items (Fisher–Yates prefix). */
function sample<T>(items: readonly T[], k: number, rng: () => number): T[] {
  if (items.length <= k) return [...items]
  const arr = [...items]
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (arr.length - i))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr.slice(0, k)
}

/** How good is this position? This is the AI's UNDERSTANDING of the game — with a coarse score (just
 *  cleared% + boss%) every playout that reaches a similar board looks identical, so no move stands out
 *  and it plays randomly no matter how deep it searches. So this scores the *strategy* of a position:
 *
 *   - progress toward the two win conditions (field cleared, Boss dead), the dominant terms;
 *   - a big GATHERED cluster near the Boss — armed mines in (or near) strike range, weighted by stack,
 *     because that packed blob is what actually delivers the kill (it's most of "playing well");
 *   - stack size — the overlap-boost payoff — so building a fat mine reads as progress;
 *   - resources banked (ammo, hooks, charge) — lightly;
 *   - and an explicit LOSS penalty, so it actively avoids throwing the run (the old eval scored a loss
 *     as mildly positive, so it barely cared about losing).
 *
 *  Paired with a short rollout cap, this lets even a light search choose moves that visibly build and
 *  deliver, instead of averaging out over 90 moves of playout. */
function evaluate(engine: MinesweeperEngine): number {
  const s = engine.snapshot()
  // A win dominates everything — but a win in FEWER MOVES and LESS TIME scores higher, so the search
  // strives to finish efficiently (plan the fewest, biggest moves) rather than bumble to the line.
  if (s.status === 'won') return 100_000 - s.moves * 60 - s.timeElapsed * 8
  if (s.status === 'lost') return -60_000 // losing is strictly bad

  const boss = bossOf(s)
  const strikeRange = s.blastRadiusCap + 1 // a mine this close can hit the Boss
  let clearedOrGone = 0
  let clusterValue = 0 // gathered killing power near the Boss, weighted by stack and proximity
  let biggestStack = 0
  let armedStackTotal = 0
  const inRange: { x: number; y: number; stk: number }[] = [] // armed mines that can strike the Boss
  const armedList: { x: number; y: number; stk: number }[] = [] // every armed mine (for loaded-blast)
  const coveredList: { x: number; y: number }[] = [] // every standing field enemy (blast fodder)
  for (const t of s.tiles) {
    if (t.state === 'cleared' || t.state === 'detonated') clearedOrGone++
    else if (t.state === 'covered' || t.state === 'cracked') {
      if (t.tier !== 'boss') coveredList.push({ x: t.coord.x, y: t.coord.y })
    } else if (t.state === 'armed') {
      const stk = t.mineCharge ?? 1
      armedStackTotal += stk
      if (stk > biggestStack) biggestStack = stk
      armedList.push({ x: t.coord.x, y: t.coord.y, stk })
      const d = cheb(t.coord, boss)
      // In strike range → full value; otherwise decays with distance (a mine 3 rings out is worth
      // far less than one on the doorstep). This makes GATHERING toward the Boss score as progress.
      clusterValue += d <= strikeRange ? stk : stk / (1 + (d - strikeRange))
      if (d <= strikeRange) inRange.push({ x: t.coord.x, y: t.coord.y, stk })
    }
  }
  // LOADED BLAST — the most field enemies any single armed mine could take RIGHT NOW: everything in its
  // stack's blast radius, plus a shrapnel ring. A fat mine sitting on a crowd scores high here, so the
  // search is pulled toward BUILDING one (pumping a keystone) and FIRING it into the pack — the "clear a
  // whole crowd in one blast" play — instead of popping stack-1 mines one at a time across the board.
  // This is the term that makes the clearing phase look planned rather than scattered.
  let loadedBlast = 0
  for (const m of armedList) {
    const r = blastRadiusForStack(m.stk, s.blastRadiusCap)
    const reach = Math.min(r + 1, s.shrapnelMaxReach)
    const shrapnelCap = Math.floor(m.stk * s.shrapnelPerStack)
    let inRadius = 0
    let ring = 0
    for (const c of coveredList) {
      const d = Math.max(Math.abs(c.x - m.x), Math.abs(c.y - m.y))
      if (d <= r) inRadius++
      else if (d <= reach) ring++
    }
    const killed = inRadius + Math.min(ring, shrapnelCap) // radius vaporises all; shrapnel caps by stack
    if (killed > loadedBlast) loadedBlast = killed
  }
  // Tightness: a TIGHT blob of in-range mines chains far better than the same mines with gaps between
  // them (an overlapping detonation pumps its neighbours). Reward adjacency so it PACKS the cluster —
  // hooking mines together — instead of leaving holes a chain would skip.
  let tightness = 0
  for (let i = 0; i < inRange.length; i++)
    for (let j = i + 1; j < inRange.length; j++)
      if (Math.max(Math.abs(inRange[i]!.x - inRange[j]!.x), Math.abs(inRange[i]!.y - inRange[j]!.y)) <= 1)
        tightness += Math.min(inRange[i]!.stk, inRange[j]!.stk)

  const clearedFraction = clearedOrGone / s.tiles.length
  const bossFraction = s.bossMaxHp > 0 ? 1 - s.bossHp / s.bossMaxHp : 1
  const shieldStripped = s.bossShieldMax > 0 ? 1 - s.bossShield / s.bossShieldMax : 1

  // KILL-POOL MARGIN — the loss condition the old eval was blind to, and the reason it played like it
  // was making random moves. You LOSE the instant the mines still on the board can no longer, even
  // perfectly chained, deal the Boss's remaining HP. So every mine is precious ammo: detonating one
  // in a far corner for a couple of ground tiles drains this pool for almost nothing, and enough of
  // that throws the run — which is exactly what the old eval rewarded (clearing any tile scored big).
  // `maxDeliverable` mirrors the engine's own bossStillKillable bound (triangular stacking, capped).
  // We do NOT reward a fat margin (you must spend the pool to win) — we PUNISH letting it approach
  // zero, a cliff that makes wasteful detonations read as the mistakes they are while leaving genuine
  // boss-damage detonations (which shrink HP as fast as they shrink the pool) net-positive.
  const cap = s.stackCap
  const mines = s.minesRemaining
  const maxDeliverable = mines <= cap ? (mines * (mines + 1)) / 2 : (cap * (cap + 1)) / 2 + (mines - cap) * cap
  const margin = maxDeliverable - s.bossHp
  const buffer = Math.max(3, s.bossHp * 0.6) // "comfortable" slack, relative to what's left to kill
  const marginPenalty = margin <= 0 ? 30_000 : margin < buffer ? ((buffer - margin) / buffer) * 9000 : 0

  return (
    bossFraction * 7000 + // killing the Boss is the whole point — dominate all but an actual win
    shieldStripped * 1400 + // stripping the shield is the gate to HP damage
    clusterValue * 130 + // a packed, in-range cluster is what delivers the kill — reward building it
    tightness * 100 + // adjacency within that cluster — pack it tight so it chains (hook mines together)
    biggestStack * 70 + // growing a fat keystone mine (the overlap-boost payoff) is real progress
    loadedBlast * 55 + // a big blast primed over a crowd — reward BUILDING toward it, not stack-1 pops
    clearedFraction * 1100 + // the OTHER win condition — but far below boss work, so it won't cash a mine for corners
    armedStackTotal * 5 + // some armed ordnance on the board is good
    s.minesRemaining * 16 + // ammo is precious: spending a mine must earn more than a couple of tiles
    s.hookCharges * 4 - // holding a hook is mildly good, not so much that it hoards them unused
    marginPenalty - // the cliff — never drain the kill pool below what still finishes the Boss
    s.moves * 12 - // MOVE penalty: fewer, bigger moves. The rising per-run pressure rides on this term
    s.timeElapsed * 6 // and the clock
  )
}

/** One playout from `engine` (mutated in place): play the heuristic policy — with a dash of random
 *  exploration so playouts vary — until the game ends or the cap is hit, then score the result. */
function rollout(engine: MinesweeperEngine, cap: number, rng: () => number): number {
  for (let i = 0; i < cap; i++) {
    const snap = engine.snapshot()
    if (snap.status !== 'playing') break
    let action = autoPlay(snap)
    // Occasionally deviate from the heuristic so playouts explore off-policy lines.
    if (rng() < 0.12) {
      const cand = candidateActions(snap, 4, rng)
      if (cand.length > 0) action = cand[Math.floor(rng() * cand.length)]!
    }
    if (action) applyAction(engine, action)
    engine.tick(SECONDS_PER_MOVE)
  }
  return evaluate(engine)
}

interface Node {
  readonly action: AutoAction | null // the move that produced this node's state (null at the root)
  readonly state: MinesweeperEngine // the state AFTER `action` — an owned clone
  readonly parent: Node | null
  readonly children: Node[]
  readonly untried: AutoAction[]
  visits: number
  total: number // summed rollout value
}

function makeNode(state: MinesweeperEngine, action: AutoAction | null, parent: Node | null, revealSamples: number, rng: () => number): Node {
  return {
    action,
    state,
    parent,
    children: [],
    untried: candidateActions(state.snapshot(), revealSamples, rng),
    visits: 0,
    total: 0,
  }
}

/** UCB1 pick among fully-expanded children. Ties (and the exploration term) draw on `rng`, so the AI
 *  doesn't fixate on the first-best line — part of why it plays variedly. */
function bestChild(node: Node, explore: number, rng: () => number): Node {
  let best: Node | null = null
  let bestScore = -Infinity
  const logN = Math.log(node.visits + 1)
  for (const c of node.children) {
    const exploit = c.total / c.visits
    const ucb = exploit + explore * Math.sqrt(logN / c.visits) + rng() * 1e-6
    if (ucb > bestScore) {
      bestScore = ucb
      best = c
    }
  }
  return best!
}

/**
 * Choose the next move for the live game by searching from its current position. Returns null only
 * when there is genuinely nothing to do (game over, or no legal candidate — the caller should then
 * let the clock tick so charge regenerates).
 */
export function chooseAction(engine: MinesweeperEngine, options: MctsOptions = {}): AutoAction | null {
  if (engine.snapshot().status !== 'playing') return null
  const rng = options.rng ?? Math.random
  const opts = {
    iterations: options.iterations ?? DEFAULTS.iterations,
    explore: options.explore ?? DEFAULTS.explore,
    revealSamples: options.revealSamples ?? DEFAULTS.revealSamples,
    rolloutCap: options.rolloutCap ?? DEFAULTS.rolloutCap,
  }

  const root = makeNode(engine.clone(), null, null, opts.revealSamples, rng)
  if (root.untried.length === 0 && root.children.length === 0) return null

  // A wall-clock budget caps per-move latency for the live demo; otherwise use the fixed iteration
  // count. `iterations` always bounds the loop so a bad clock can't hang it. When budgeting time,
  // raise that ceiling so the budget — not the count — is what stops us.
  const timed = options.timeBudgetMs !== undefined
  const maxIters = timed ? Math.max(opts.iterations, 100_000) : opts.iterations
  const deadline = timed ? now() + options.timeBudgetMs! : Infinity

  for (let it = 0; it < maxIters; it++) {
    if (timed && it >= 4 && now() >= deadline) break
    // 1. Selection — descend fully-expanded, non-terminal nodes by UCB.
    let node = root
    while (node.untried.length === 0 && node.children.length > 0) {
      node = bestChild(node, opts.explore, rng)
    }

    // 2. Expansion — try one unexplored action from this node.
    if (node.untried.length > 0 && node.state.snapshot().status === 'playing') {
      const idx = Math.floor(rng() * node.untried.length)
      const action = node.untried.splice(idx, 1)[0]!
      const childState = node.state.clone()
      applyAction(childState, action)
      childState.tick(SECONDS_PER_MOVE)
      const child = makeNode(childState, action, node, opts.revealSamples, rng)
      node.children.push(child)
      node = child
    }

    // 3. Simulation — play the node's state out and score it.
    const value = rollout(node.state.clone(), opts.rolloutCap, rng)

    // 4. Backpropagation — credit the value up to the root.
    for (let n: Node | null = node; n; n = n.parent) {
      n.visits += 1
      n.total += value
    }
  }

  // Commit to the most-visited root move (the line the search trusted most), not the highest mean —
  // visit count is the robust MCTS choice, less swayed by a single lucky playout.
  let choice: Node | null = null
  let bestVisits = -1
  for (const c of root.children) {
    if (c.visits > bestVisits) {
      bestVisits = c.visits
      choice = c
    }
  }
  return choice?.action ?? null
}
