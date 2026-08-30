/**
 * Balance invariants, guarded in CI rather than eyeballed in the sweep. These are coarse
 * on purpose — they catch a tuning change that breaks the *shape* of the game (boards
 * become unwinnable, or blind-probing starts to pay), not fine feel, which only real play
 * settles. If one of these goes red, a constant in tuning.ts moved too far.
 */

import { describe, it, expect } from 'vitest'
import { runGame } from './run'
import { greedyBot, blindProberBot } from './bots'
import type { Difficulty } from '../engine/types'

function winRate(difficulty: Difficulty, bot: typeof greedyBot, n: number): number {
  let wins = 0
  for (let i = 0; i < n; i++) {
    if (runGame(difficulty, `bal-${difficulty}-${i}`, bot).outcome === 'won') wins++
  }
  return wins / n
}

const N = 40

describe.each<Difficulty>(['gentle', 'standard', 'hard'])('balance: %s', difficulty => {
  it('a sensible player wins the clear majority of boards', () => {
    expect(winRate(difficulty, greedyBot, N)).toBeGreaterThanOrEqual(0.6)
  })

  it('blind-probing the board loses far more than sensible play wins', () => {
    const greedy = winRate(difficulty, greedyBot, N)
    const prober = winRate(difficulty, blindProberBot, N)
    // The whole economy exists to make ignoring it lose. Probing should be near-zero and
    // must not approach honest play.
    expect(prober).toBeLessThan(0.1)
    expect(prober).toBeLessThan(greedy - 0.4)
  })
})
