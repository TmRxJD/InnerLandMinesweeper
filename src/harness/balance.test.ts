/**
 * Balance invariants, guarded in CI rather than eyeballed in the sweep. Coarse on purpose:
 * they catch a tuning change that breaks the *shape* of the game — a board that can't be
 * completed, or a clear that blows past par — not fine feel. If one goes red, a constant in
 * tuning.ts moved too far.
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

const N = 40

describe.each<Difficulty>(['gentle', 'standard', 'hard'])('balance: %s', difficulty => {
  it('every board is completable by a sensible player', () => {
    const rs = runs(difficulty, greedyBot, N)
    expect(rs.every(r => r.finished)).toBe(true)
  })

  it('a sensible player clears comfortably under par', () => {
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
