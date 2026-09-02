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
  rolloutCap: 180,
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

  // Hook the handful of mines nearest the Boss toward it (delivery across the moat) and toward each
  // other (to cluster for the chain). Capped to the closest few so the branching stays searchable.
  if (snap.hookCharges >= 1 && armed.length > 0) {
    const nearest6 = [...armed].sort((a, b) => cheb(a.coord, boss) - cheb(b.coord, boss)).slice(0, 6)
    for (const m of nearest6) {
      const toBoss = { x: Math.sign(boss.x - m.coord.x), y: Math.sign(boss.y - m.coord.y) }
      if (toBoss.x || toBoss.y) out.push({ type: 'hook', coord: m.coord, dir: toBoss })
      const mate = nearest(m, nearest6)
      if (mate) {
        const toMate = { x: Math.sign(mate.coord.x - m.coord.x), y: Math.sign(mate.coord.y - m.coord.y) }
        if ((toMate.x || toMate.y) && (toMate.x !== toBoss.x || toMate.y !== toBoss.y)) {
          out.push({ type: 'hook', coord: m.coord, dir: toMate })
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

/** The armed mine nearest to `m` (excluding itself), or null. */
function nearest(m: TileView, pool: TileView[]): TileView | null {
  let best: TileView | null = null
  let bestD = Infinity
  for (const o of pool) {
    if (o === m) continue
    const d = cheb(m.coord, o.coord)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
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

/** Score a finished-or-abandoned playout. A win dominates everything (and a faster win scores higher);
 *  an unfinished line is valued by how far it got — ground cleared and Boss chipped down — so the
 *  search still climbs toward the goal before any playout reaches it. */
function evaluate(engine: MinesweeperEngine): number {
  const s = engine.snapshot()
  if (s.status === 'won') return 10_000 - s.timeElapsed // faster win → higher
  let clearedOrGone = 0
  for (const t of s.tiles) if (t.state === 'cleared' || t.state === 'detonated') clearedOrGone++
  const clearedFraction = clearedOrGone / s.tiles.length
  const bossFraction = s.bossMaxHp > 0 ? 1 - s.bossHp / s.bossMaxHp : 1
  return (clearedFraction * 0.6 + bossFraction * 0.4) * 1000 // 0..1000, always below any win
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
