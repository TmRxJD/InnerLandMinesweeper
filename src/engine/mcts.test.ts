import { describe, expect, it } from 'vitest'
import { createEngine } from './engine'
import { chooseAction } from './mcts'
import type { AutoAction } from './auto-player'

/** A tiny seeded RNG so the search is reproducible in tests (production uses Math.random). */
function seededRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function apply(engine: ReturnType<typeof createEngine>, a: AutoAction): void {
  if (a.type === 'reveal') engine.reveal(a.coord)
  else if (a.type === 'hook') engine.useHook(a.coord, a.dir ?? { x: 0, y: 0 })
  else engine.detonate(a.coord)
}

describe('mcts planner', () => {
  it('proposes a legal action from a fresh position', () => {
    const engine = createEngine({ difficulty: 'gentle', seed: 'mcts-legal' })
    const action = chooseAction(engine, { iterations: 24, rng: seededRng(1) })
    expect(action).not.toBeNull()
    expect(['reveal', 'detonate', 'hook']).toContain(action!.type)
  })

  it('never mutates the live game while searching (it only clones)', () => {
    const engine = createEngine({ difficulty: 'standard', seed: 'mcts-pure' })
    // Open the game up a bit so the search has armed mines and real branching to explore.
    for (let i = 0; i < 12; i++) {
      const a = chooseAction(engine, { iterations: 16, rng: seededRng(10 + i) })
      if (a) apply(engine, a)
      engine.tick(0.45)
    }
    const before = JSON.stringify(engine.snapshot())
    chooseAction(engine, { iterations: 40, rng: seededRng(999) })
    expect(JSON.stringify(engine.snapshot())).toBe(before) // search left no trace on the real state
  })

  it('plans an entire game and wins it (clear + Boss dead)', () => {
    const engine = createEngine({ difficulty: 'gentle', seed: 'mcts-full' })
    let stuck = 0
    let last = ''
    for (let i = 0; i < 4000 && engine.snapshot().status === 'playing'; i++) {
      const action = chooseAction(engine, { iterations: 40, rng: seededRng(5000 + i) })
      if (action) apply(engine, action)
      engine.tick(0.45)
      const s = engine.snapshot()
      let cleared = 0
      for (const t of s.tiles) if (t.state === 'cleared' || t.state === 'detonated') cleared++
      const sig = `${cleared}|${s.bossHp}|${Math.floor(s.playerCharge)}`
      stuck = sig === last ? stuck + 1 : 0
      last = sig
      expect(stuck).toBeLessThan(50) // must keep making progress, not spin
    }
    expect(engine.snapshot().status).toBe('won')
  }, 30_000)
})
