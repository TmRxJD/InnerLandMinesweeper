/**
 * Strategic play analysis — the balance microscope.
 *
 * Win rate and clear time say nothing about *how* a game was won: a bot can stumble to a win without
 * ever using the mechanics the design leans on. This tool instruments a full playout and reports what
 * the player actually DID — how big the stacks got, whether hooks were load-bearing, how efficiently
 * blasts cleared ground, how much the Boss was over/under-killed, and how much the play VARIES run to
 * run. Those patterns are where balance problems hide:
 *
 *   pnpm analyze                    # heuristic + MCTS, all difficulties
 *   pnpm analyze -- --n 30 --diff hard
 *   pnpm analyze -- --policy mcts
 *
 * Read the "reads" block at the end for the interpretation.
 */

import { pathToFileURL } from 'node:url'
import { createEngine } from '../engine/engine'
import { DIFFICULTIES } from '../engine/tuning'
import { autoPlay } from '../engine/auto-player'
import { chooseAction } from '../engine/mcts'
import type { Difficulty, GameEvent, MinesweeperEngine } from '../engine/types'

const SECONDS_PER_MOVE = 0.45
type Policy = 'heuristic' | 'mcts'

interface GameMetrics {
  won: boolean
  time: number
  reveals: number
  detonations: number
  hooks: number
  /** Biggest stack ever detonated — did the player actually BUILD, or spam stack-1? */
  maxStackDetonated: number
  /** Ground tiles vaporised by blasts ÷ detonations — high = using mines as area weapons. */
  blastClearEfficiency: number
  /** Detonations that dealt Boss damage, and their stacks — the shape of the kill. */
  killBlasts: number
  killStacks: number[]
  /** Total STACK aimed at the Boss (sum of boss-hitting blast stacks) vs its HP. Measures how much
   *  firepower the kill actually required — well above HP means the chain has lots of headroom (Boss
   *  could be tougher / mines fewer); barely above means it's tuned tight. (Uses stack, not clamped
   *  HP loss, so the final over-delivering blast is visible instead of hidden by HP flooring at 0.) */
  bossStackThrown: number
  bossOverkill: number
  /** A near-Boss killer detonated while ground still remained — a strategic blunder (wastes a mine
   *  the kill needs). Should be ~0 for competent play; >0 means the policy is fumbling. */
  killersWastedEarly: number
}

function choose(policy: Policy, engine: MinesweeperEngine): ReturnType<typeof autoPlay> {
  return policy === 'mcts' ? chooseAction(engine, { timeBudgetMs: 60 }) : autoPlay(engine.snapshot())
}

function runInstrumented(difficulty: Difficulty, seed: string, policy: Policy): GameMetrics {
  const cfg = DIFFICULTIES[difficulty]
  const engine = createEngine({ difficulty, seed })
  const boss = { x: (cfg.width - 1) >> 1, y: (cfg.height - 1) >> 1 }
  const gatherRadius = engine.snapshot().gatherRadius

  let reveals = 0
  let detonations = 0
  let hooks = 0
  let maxStack = 0
  let blastGroundCleared = 0
  let killBlasts = 0
  const killStacks: number[] = []
  let bossStackThrown = 0
  let killersWastedEarly = 0

  let stuck = 0
  let last = ''
  for (let i = 0; i < 8000; i++) {
    const snap = engine.snapshot()
    if (snap.status !== 'playing') break
    const action = choose(policy, engine)
    if (action) {
      if (action.type === 'reveal') {
        engine.reveal(action.coord)
        reveals++
      } else if (action.type === 'hook') {
        const ev = engine.useHook(action.coord, action.dir ?? { x: 0, y: 0 })
        if (ev.some(e => e.kind === 'hookUsed')) hooks++
      } else {
        // Detonation — measure its stack, its Boss damage, and its ground clear.
        const cheb = Math.max(Math.abs(action.coord.x - boss.x), Math.abs(action.coord.y - boss.y))
        const groundLeft = snap.tiles.some(t => (t.state === 'covered' || t.state === 'cracked') && t.tier !== 'boss')
        const tile = snap.tiles.find(t => t.coord.x === action.coord.x && t.coord.y === action.coord.y)
        const stack = tile?.mineCharge ?? 1
        const bossBefore = snap.bossHp
        const ev = engine.detonate(action.coord)
        detonations++
        maxStack = Math.max(maxStack, stack)
        blastGroundCleared += countGroundCleared(ev)
        const bossAfter = engine.snapshot().bossHp
        const dmg = bossBefore - bossAfter
        if (dmg > 0) {
          killBlasts++
          killStacks.push(stack)
          bossStackThrown += stack // potential firepower, not the HP-clamped loss
        }
        if (groundLeft && cheb <= gatherRadius) killersWastedEarly++ // spent a killer mid-clear
      }
    }
    engine.tick(SECONDS_PER_MOVE)
    const s = engine.snapshot()
    let cleared = 0
    for (const t of s.tiles) if (t.state === 'cleared' || t.state === 'detonated') cleared++
    const sig = `${cleared}|${s.bossHp}|${Math.floor(s.playerCharge)}`
    stuck = sig === last ? stuck + 1 : 0
    last = sig
    if (stuck >= 60) break
  }

  const result = engine.result()
  const snap = engine.snapshot()
  return {
    won: result !== null,
    time: result?.timeSeconds ?? snap.timeElapsed,
    reveals,
    detonations,
    hooks,
    maxStackDetonated: maxStack,
    blastClearEfficiency: detonations > 0 ? blastGroundCleared / detonations : 0,
    killBlasts,
    killStacks,
    bossStackThrown,
    bossOverkill: bossStackThrown - cfg.bossHp,
    killersWastedEarly,
  }
}

function countGroundCleared(events: readonly GameEvent[]): number {
  let n = 0
  for (const e of events) if (e.kind === 'tileDestroyed') n++
  return n
}

// -- variety: does the policy play the SAME board the same way twice? ---------

/** Fraction of moves that differ between two playouts of the same seed (0 = identical, 1 = totally
 *  different). A scripted/deterministic player scores ~0; a genuinely searching one scores > 0. */
function divergence(difficulty: Difficulty, seed: string, policy: Policy): number {
  const trace = (): string[] => {
    const e = createEngine({ difficulty, seed })
    const seq: string[] = []
    let stuck = 0
    let last = ''
    for (let i = 0; i < 8000; i++) {
      const snap = e.snapshot()
      if (snap.status !== 'playing') break
      const a = choose(policy, e)
      if (a) {
        seq.push(`${a.type}:${a.coord.x},${a.coord.y}`)
        if (a.type === 'reveal') e.reveal(a.coord)
        else if (a.type === 'hook') e.useHook(a.coord, a.dir ?? { x: 0, y: 0 })
        else e.detonate(a.coord)
      }
      e.tick(SECONDS_PER_MOVE)
      const s = e.snapshot()
      let c = 0
      for (const t of s.tiles) if (t.state === 'cleared' || t.state === 'detonated') c++
      const sig = `${c}|${s.bossHp}`
      stuck = sig === last ? stuck + 1 : 0
      last = sig
      if (stuck >= 60) break
    }
    return seq
  }
  const a = trace()
  const b = trace()
  const n = Math.max(a.length, b.length)
  if (n === 0) return 0
  let diff = 0
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++
  return diff / n
}

// -- aggregate + report -------------------------------------------------------

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]!
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function analyze(difficulty: Difficulty, n: number, policy: Policy): void {
  const cfg = DIFFICULTIES[difficulty]
  const games: GameMetrics[] = []
  for (let i = 0; i < n; i++) games.push(runInstrumented(difficulty, `an-${difficulty}-${i}`, policy))
  const won = games.filter(g => g.won)
  const div = mean(Array.from({ length: Math.min(n, 3) }, (_, i) => divergence(difficulty, `an-${difficulty}-${i}`, policy)))

  const allKillStacks = won.flatMap(g => g.killStacks)
  const minStack = allKillStacks.length ? Math.min(...allKillStacks) : 0
  const maxStack = allKillStacks.length ? Math.max(...allKillStacks) : 0
  console.log(
    `\n[${difficulty} · ${policy}] boss ${cfg.bossHp}hp, stackCap ${cfg.stackCap}, ${won.length}/${n} won`,
  )
  console.log(
    `  action mix     reveals ${Math.round(mean(won.map(g => g.reveals)))}  detonations ${Math.round(mean(won.map(g => g.detonations)))}  hooks ${mean(won.map(g => g.hooks)).toFixed(1)}`,
  )
  console.log(
    `  stack building max ${median(won.map(g => g.maxStackDetonated))} (of ${cfg.stackCap})  ·  kill blasts ${median(won.map(g => g.killBlasts))} @ stacks {min ${minStack}, med ${median(allKillStacks)}, max ${maxStack}}`,
  )
  console.log(
    `  boss economy   stack thrown ${Math.round(mean(won.map(g => g.bossStackThrown)))} vs ${cfg.bossHp}hp  ·  overkill ${mean(won.map(g => g.bossOverkill)).toFixed(1)} (${Math.round((mean(won.map(g => g.bossOverkill)) / cfg.bossHp) * 100)}%)`,
  )
  console.log(
    `  blast eff.     ${mean(won.map(g => g.blastClearEfficiency)).toFixed(1)} ground/detonation  ·  killers wasted early ${mean(won.map(g => g.killersWastedEarly)).toFixed(2)}/game`,
  )
  console.log(
    `  variety        ${(div * 100).toFixed(0)}% of moves differ between two runs of the same board`,
  )
}

function main(): void {
  const args = process.argv.slice(2)
  const nArg = args.indexOf('--n')
  const n = nArg >= 0 ? Number(args[nArg + 1]) : 20
  const dArg = args.indexOf('--diff')
  const diffs: Difficulty[] = dArg >= 0 ? [args[dArg + 1] as Difficulty] : ['gentle', 'standard', 'hard']
  const pArg = args.indexOf('--policy')
  const policies: Policy[] = pArg >= 0 ? [args[pArg + 1] as Policy] : ['heuristic', 'mcts']

  console.log(`Inner Land Minesweeper — strategic analysis (n=${n})`)
  for (const d of diffs) for (const p of policies) analyze(d, n, p)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
