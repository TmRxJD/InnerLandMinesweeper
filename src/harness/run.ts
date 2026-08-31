/**
 * Headless playout runner + speed sweep.
 *
 *   pnpm harness                 # sweep all difficulties, all bots, default sample
 *   pnpm harness -- --n 500      # larger sample
 *   pnpm harness -- --diff hard  # single difficulty
 *
 * The board is always completable and the clock only ranks you, so the metric is TIME, not
 * win rate: median clear time per bot, plus the medal split. A reasonable bot should clear
 * comfortably under par; the blind-prober should be much slower. Boards that no bot can finish
 * within the action cap are flagged (bad mine supply near the centre).
 */

import { createEngine } from '../engine/engine'
import { DIFFICULTIES, medalForTime } from '../engine/tuning'
import type { Difficulty, GameResult } from '../engine/types'
import { ALL_BOTS, type Bot } from './bots'

/** Simulated wall-clock a player spends per action — the timer advances between moves. */
const SECONDS_PER_MOVE = 0.45
/** Hard cap on actions so a stuck bot can't spin forever. */
const MAX_ACTIONS = 8000

/** Board state that changes on any real headway (a clear, an arm, a charge move). */
function progressSig(snap: ReturnType<MinesweeperEngineSnapshot>): string {
  let cleared = 0
  let armed = 0
  for (const t of snap.tiles) {
    if (t.state === 'cleared' || t.state === 'detonated') cleared++
    else if (t.state === 'armed') armed++
  }
  return `${cleared}|${armed}|${snap.playerCharge}|${snap.bossHp}`
}
type MinesweeperEngineSnapshot = ReturnType<typeof createEngine>['snapshot']

export interface RunOutcome {
  finished: boolean
  timeSeconds: number
  moves: number
  result: GameResult | null
}

export function runGame(difficulty: Difficulty, seed: string, bot: Bot): RunOutcome {
  const engine = createEngine({ difficulty, seed })
  let stuck = 0
  let lastSig = ''
  let elapsed = 0
  for (let i = 0; i < MAX_ACTIONS; i++) {
    const snap = engine.snapshot()
    if (snap.status !== 'playing') break
    const action = bot.step(snap)
    if (action) {
      if (action.type === 'reveal') engine.reveal(action.coord)
      else if (action.type === 'hook') engine.useHook(action.coord, action.dir ?? { x: 0, y: 0 })
      else engine.detonate(action.coord)
    }
    engine.tick(SECONDS_PER_MOVE)
    elapsed += SECONDS_PER_MOVE
    const sig = progressSig(engine.snapshot())
    stuck = sig === lastSig ? stuck + 1 : 0
    lastSig = sig
    if (stuck >= 40) break // genuinely stuck (no regen, no useful move)
  }
  const result = engine.result()
  return { finished: result !== null, timeSeconds: result?.timeSeconds ?? elapsed, moves: engine.snapshot().moves, result }
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
  finishedPct: number
  medTime: number
  fastest: number
  slowest: number
  medMoves: number
  medals: { gold: number; silver: number; bronze: number; none: number }
}

function sweep(difficulty: Difficulty, n: number): Agg[] {
  const cfg = DIFFICULTIES[difficulty]
  return ALL_BOTS.map(bot => {
    const runs: RunOutcome[] = []
    for (let i = 0; i < n; i++) runs.push(runGame(difficulty, `sweep-${difficulty}-${i}`, bot))
    const finished = runs.filter(r => r.finished)
    const medals = { gold: 0, silver: 0, bronze: 0, none: 0 }
    for (const r of finished) medals[medalForTime(cfg, r.timeSeconds)]++
    return {
      bot: bot.name,
      n,
      finishedPct: finished.length / n,
      medTime: median(finished.map(r => r.timeSeconds)),
      fastest: finished.length ? Math.min(...finished.map(r => r.timeSeconds)) : 0,
      slowest: finished.length ? Math.max(...finished.map(r => r.timeSeconds)) : 0,
      medMoves: median(runs.map(r => r.moves)),
      medals,
    }
  })
}

function report(difficulty: Difficulty, aggs: Agg[]): void {
  const cfg = DIFFICULTIES[difficulty]
  console.log(
    `\n=== ${difficulty.toUpperCase()}  (${cfg.width}x${cfg.height}, ${cfg.mineCount} mines, boss ${cfg.bossHp}hp, par ${cfg.parSeconds}s) ===`,
  )
  console.log(['bot'.padEnd(12), 'fin'.padStart(5), 'medTime'.padStart(8), 'fast'.padStart(6), 'slow'.padStart(6), 'moves'.padStart(6), 'medals(G/S/B/-)'.padStart(16)].join(' '))
  for (const a of aggs) {
    const m = a.medals
    console.log(
      [
        a.bot.padEnd(12),
        `${Math.round(a.finishedPct * 100)}%`.padStart(5),
        `${a.medTime}s`.padStart(8),
        `${a.fastest}s`.padStart(6),
        `${a.slowest}s`.padStart(6),
        `${a.medMoves}`.padStart(6),
        `${m.gold}/${m.silver}/${m.bronze}/${m.none}`.padStart(16),
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

  console.log(`Inner Land Minesweeper — speed sweep (n=${n}, ${SECONDS_PER_MOVE}s/move)`)
  const flags: string[] = []
  for (const d of diffs) {
    const aggs = sweep(d, n)
    report(d, aggs)
    const greedy = aggs.find(a => a.bot === 'greedy')!
    const prober = aggs.find(a => a.bot === 'blindProber')!
    if (greedy.finishedPct < 0.98) {
      flags.push(`⚠ ${d}: greedy finished only ${Math.round(greedy.finishedPct * 100)}% — some boards can't be completed (mine supply near centre?)`)
    }
    // Skill is rewarded if blind play mostly can't finish, or finishes slower than greedy.
    if (prober.finishedPct > 0.5 && greedy.medTime >= prober.medTime) {
      flags.push(`⚠ ${d}: greedy (${greedy.medTime}s) not faster than blindProber (${prober.medTime}s) — skill isn't rewarded`)
    }
  }
  console.log('\n--- flags ---')
  if (flags.length === 0) console.log('none — every board completes; skilled play clears faster')
  else for (const f of flags) console.log(f)
}

main()
