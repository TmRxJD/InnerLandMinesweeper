/**
 * Headless playout runner + balance sweep.
 *
 *   pnpm harness                 # sweep all difficulties, all bots, default sample
 *   pnpm harness -- --n 500      # larger sample
 *   pnpm harness -- --diff hard  # single difficulty
 *
 * Output is a table per difficulty: win rate, median time left, median cracks, median
 * detonations, median moves, median maxChain. Read it against docs/GAME_DESIGN.md's
 * "known balance risk" — greedy/patient should win comfortably; blindProber should not.
 */

import { createEngine } from '../engine/engine'
import { DIFFICULTIES } from '../engine/tuning'
import type { Difficulty, GameResult } from '../engine/types'
import { ALL_BOTS, type Bot } from './bots'

/** Simulated wall-clock a player spends per action. Advances the game timer between moves
 *  so a slow/looping bot can actually run out of time. */
const SECONDS_PER_MOVE = 2
/** Hard cap on actions so a stuck bot can't spin forever. */
const MAX_ACTIONS = 5000

/** Board state that changes on any real headway: a clear, a chip (damage dealt), an arm, or
 *  charge moving (e.g. regenerating while waiting). Chipping matters, so include crack sums. */
function progressSig(snap: ReturnType<MinesweeperEngineSnapshot>): string {
  let cleared = 0
  let armed = 0
  let crack10 = 0
  for (const t of snap.tiles) {
    if (t.state === 'cleared' || t.state === 'detonated') cleared++
    else if (t.state === 'armed') armed++
    if (t.crack !== undefined) crack10 += Math.round(t.crack * 10)
  }
  return `${cleared}|${armed}|${crack10}|${snap.playerCharge}`
}
type MinesweeperEngineSnapshot = ReturnType<typeof createEngine>['snapshot']

export function runGame(difficulty: Difficulty, seed: string, bot: Bot): GameResult {
  let t = 0
  const engine = createEngine({ difficulty, seed, now: () => t })
  let stuck = 0
  let lastSig = ''
  for (let i = 0; i < MAX_ACTIONS; i++) {
    const snap = engine.snapshot()
    if (snap.status !== 'playing') break
    const action = bot.step(snap)
    // A null action means "nothing to do right now" — often just waiting for charge to
    // regen. Advance time either way; the no-progress guard below ends a truly stuck board.
    if (action) {
      if (action.type === 'reveal') engine.reveal(action.coord)
      else engine.detonate(action.coord)
    }
    t += SECONDS_PER_MOVE
    engine.tick(SECONDS_PER_MOVE)
    // No-progress guard: if several moves in a row change nothing (e.g. broke, probing
    // Commons that are all ground), the board is stuck — stop rather than spin.
    const sig = progressSig(engine.snapshot())
    stuck = sig === lastSig ? stuck + 1 : 0
    lastSig = sig
    if (stuck >= 12) break
  }
  return (
    engine.result() ?? {
      seed,
      difficulty,
      outcome: 'lost',
      score: 0,
      durationSeconds: Math.round(t),
      timeRemaining: 0,
      moves: MAX_ACTIONS,
      detonations: 0,
      maxChain: 0,
      cracks: 0,
      tilesCleared: 0,
      boardClearedFraction: 0,
    }
  )
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

interface Agg {
  bot: string
  n: number
  winRate: number
  medTimeLeft: number
  medCracks: number
  medDetonations: number
  medMoves: number
  medMaxChain: number
  medClearedPct: number
}

function sweep(difficulty: Difficulty, n: number): Agg[] {
  return ALL_BOTS.map(bot => {
    const results: GameResult[] = []
    for (let i = 0; i < n; i++) results.push(runGame(difficulty, `sweep-${difficulty}-${i}`, bot))
    const wins = results.filter(r => r.outcome === 'won')
    return {
      bot: bot.name,
      n,
      winRate: wins.length / n,
      medTimeLeft: median(wins.map(r => r.timeRemaining)),
      medCracks: median(results.map(r => r.cracks)),
      medDetonations: median(results.map(r => r.detonations)),
      medMoves: median(results.map(r => r.moves)),
      medMaxChain: median(results.map(r => r.maxChain)),
      medClearedPct: Math.round(median(results.map(r => r.boardClearedFraction)) * 100),
    }
  })
}

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`.padStart(5)
}

function report(difficulty: Difficulty, aggs: Agg[]): void {
  const cfg = DIFFICULTIES[difficulty]
  console.log(`\n=== ${difficulty.toUpperCase()}  (${cfg.width}x${cfg.height}, ${cfg.mineCount} mines, ${cfg.timerSeconds}s) ===`)
  console.log(
    ['bot'.padEnd(12), 'win'.padStart(5), 'timeLeft'.padStart(9), 'cracks'.padStart(7), 'dets'.padStart(6), 'moves'.padStart(6), 'chain'.padStart(6), 'clr%'.padStart(5)].join(' '),
  )
  for (const a of aggs) {
    console.log(
      [
        a.bot.padEnd(12),
        fmtPct(a.winRate),
        `${a.medTimeLeft}`.padStart(9),
        `${a.medCracks}`.padStart(7),
        `${a.medDetonations}`.padStart(6),
        `${a.medMoves}`.padStart(6),
        `${a.medMaxChain}`.padStart(6),
        `${a.medClearedPct}%`.padStart(5),
      ].join(' '),
    )
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const nArg = args.indexOf('--n')
  const n = nArg >= 0 ? Number(args[nArg + 1]) : 200
  const diffArg = args.indexOf('--diff')
  const diffs: Difficulty[] = diffArg >= 0 ? [args[diffArg + 1] as Difficulty] : ['gentle', 'standard', 'hard']

  console.log(`Inner Land Minesweeper — playout sweep (n=${n}, ${SECONDS_PER_MOVE}s/move)`)
  const flags: string[] = []
  for (const d of diffs) {
    const aggs = sweep(d, n)
    report(d, aggs)
    const greedy = aggs.find(a => a.bot === 'greedy')!
    const prober = aggs.find(a => a.bot === 'blindProber')!
    if (prober.winRate >= greedy.winRate) {
      flags.push(`⚠ ${d}: blindProber (${fmtPct(prober.winRate)}) >= greedy (${fmtPct(greedy.winRate)}) — economy not punishing enough`)
    }
    if (greedy.winRate < 0.6) {
      flags.push(`⚠ ${d}: greedy win rate ${fmtPct(greedy.winRate)} < 60% — boards may be too hard / timer too tight`)
    }
  }
  console.log('\n--- flags ---')
  if (flags.length === 0) console.log('none — greedy comfortably beats blindProber, boards completable')
  else for (const f of flags) console.log(f)
}

main()
