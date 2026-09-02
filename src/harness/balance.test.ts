/**
 * Balance invariants, guarded in CI rather than eyeballed in the sweep. Coarse on purpose:
 * they catch a tuning change that breaks the *shape* of the game. Mines are one scarce pool spent
 * on both clearing and the Boss, so a run is losable — the invariant is no longer "every board
 * completes" (careless play SHOULD fail) but "the game is hard yet fair": a sensible player wins a
 * healthy share, blind/careless play almost never does, and skilled play is faster.
 */

import { describe, it, expect } from 'vitest'
import { runGame } from './run'
import { greedyBot, blindProberBot } from './bots'
import { DIFFICULTIES } from '../engine/tuning'
import type { Difficulty } from '../engine/types'

function runs(difficulty: Difficulty, bot: typeof greedyBot, n: number) {
  return Array.from({ length: n }, (_, i) => runGame(difficulty, `bal-${difficulty}-${i}`, bot))
}
function medianTime(rs: ReturnType<typeof runGame>[]): number {
  const t = rs.filter(r => r.finished).map(r => r.timeSeconds).sort((a, b) => a - b)
  return t.length ? t[Math.floor(t.length / 2)]! : Infinity
}

function winRate(rs: ReturnType<typeof runGame>[]): number {
  return rs.filter(r => r.finished).length / rs.length
}

const N = 40

describe.each<Difficulty>(['gentle', 'standard', 'hard'])('balance: %s', difficulty => {
  it('winnable at the floor, and careless play almost never wins', () => {
    // `greedyBot` is the fast HEURISTIC — a mediocre FLOOR player, not skilled play. The game is
    // tuned to be a genuinely hard speedrun for that floor (in-game Autoplay and a real human use the
    // MCTS planner and win a far larger share). So we only require the floor to win a *nonzero* share
    // — proof the game stays beatable — while careless blind play, which spends the mine pool dry,
    // essentially never wins. (Win% is a weak proxy for strategy; the real check is watching the
    // planner play — see docs. This test is a guardrail against "impossible" or "cheeseable", nothing
    // more.)
    const floor = winRate(runs(difficulty, greedyBot, N))
    const careless = winRate(runs(difficulty, blindProberBot, N))
    expect(floor).toBeGreaterThan(0.1) // still beatable even by the weak heuristic
    expect(floor).toBeLessThan(0.95)
    expect(careless).toBeLessThan(0.1) // no cheese path
  })

  it('a sensible player clears comfortably under par (on the boards it wins)', () => {
    const rs = runs(difficulty, greedyBot, N)
    expect(medianTime(rs)).toBeLessThan(DIFFICULTIES[difficulty].parSeconds)
  })

  it('skilled play is faster than blind-probing', () => {
    const greedy = medianTime(runs(difficulty, greedyBot, N))
    const prober = medianTime(runs(difficulty, blindProberBot, N))
    // The timer is the antagonist: ignoring the mine economy should be measurably slower.
    expect(greedy).toBeLessThan(prober)
  })
})
