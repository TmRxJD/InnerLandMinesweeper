import { describe, expect, it } from 'vitest'
import { createEngine } from './engine'
import { planMove } from './auto-player'
import type { Difficulty } from './types'

describe('playable showcase planner', () => {
  it.each<Difficulty>(['gentle', 'standard', 'hard'])('clears real %s boards and kills the shielded Boss', difficulty => {
    for (let seed = 0; seed < 8; seed++) {
      const engine = createEngine({ difficulty, seed: `showcase-${seed}`, revealHooks: true })
      for (let step = 0; step < 600 && engine.snapshot().status === 'playing'; step++) {
        const action = planMove(engine)
        if (!action) break
        if (action.type === 'reveal') engine.reveal(action.coord)
        else if (action.type === 'hook') {
          expect(engine.useHook(action.coord).some(event => event.kind === 'hookUsed')).toBe(true)
        } else engine.detonate(action.coord)
        engine.tick(0.45)
      }
      const snapshot = engine.snapshot()
      expect(snapshot.status, `${difficulty} showcase-${seed}`).toBe('won')
      expect(snapshot.bossHp).toBe(0)
      expect(snapshot.tiles.some(tile => tile.state === 'covered' || tile.state === 'cracked')).toBe(false)
      expect(engine.result()?.outcome).toBe('won')
    }
  }, 30_000)

  it('does not repeat an unaffordable inferred mine probe after a no-op', () => {
    const engine = createEngine({ difficulty: 'gentle', seed: 'showcase-1', revealHooks: true })
    let checked = false
    for (let step = 0; step < 400 && engine.snapshot().status === 'playing'; step++) {
      const action = planMove(engine)
      if (!action) break
      if (action.type === 'reveal') {
        const events = engine.reveal(action.coord)
        if (events.length === 0) {
          const next = planMove(engine)
          expect(next?.coord).not.toEqual(action.coord)
          checked = true
          break
        }
      } else if (action.type === 'hook') engine.useHook(action.coord)
      else engine.detonate(action.coord)
      engine.tick(0.45)
    }
    expect(checked).toBe(true)
  })
})
