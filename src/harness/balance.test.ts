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
  it('hard but fair: sensible play wins a healthy share, careless play almost never does', () => {
    const sensible = winRate(runs(difficulty, greedyBot, N))
    const careless = winRate(runs(difficulty, blindProberBot, N))
    // Mines are scarce: a run CAN be lost, so a sensible player does not win everything — but the
    // game must stay beatable with sense. Blind play that spends mines indiscriminately runs the
    // pool dry and should essentially never win.
    expect(sensible).toBeGreaterThan(0.4)
    expect(careless).toBeLessThan(0.15)
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
