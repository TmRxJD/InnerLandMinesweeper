import { describe, it, expect } from 'vitest'
import { createEngine } from './engine'
import { generateBoard, tileAt, type Board } from './board'
import { DIFFICULTIES } from './tuning'
import type { Coord } from './types'

const DIFF = 'gentle' as const
const cfg = DIFFICULTIES[DIFF]

/** The engine generates its own board from the seed; this reproduces it so tests can see
 *  hidden truth (mine locations, HP) that a snapshot deliberately hides. */
function truth(seed: string): Board {
  return generateBoard(cfg, seed)
}

function firstCovered(board: Board, pred: (t: ReturnType<typeof tileAt>) => boolean): Coord {
  for (const t of board.tiles) if (pred(t)) return { x: t.x, y: t.y }
  throw new Error('no matching tile')
}

describe('determinism', () => {
  it('same seed yields an identical board', () => {
    const a = generateBoard(cfg, 'seed-xyz')
    const b = generateBoard(cfg, 'seed-xyz')
    expect(a.tiles.map(t => [t.isMine, t.tier, t.maxHp])).toEqual(b.tiles.map(t => [t.isMine, t.tier, t.maxHp]))
  })

  it('different seeds differ', () => {
    const a = generateBoard(cfg, 'seed-1')
    const b = generateBoard(cfg, 'seed-2')
    expect(a.tiles.map(t => t.isMine)).not.toEqual(b.tiles.map(t => t.isMine))
  })
})

describe('opening guarantee', () => {
  it('the opening is Common, zero-adjacent, and not a mine', () => {
    const board = truth('open-seed')
    const o = tileAt(board, board.opening.x, board.opening.y)!
    expect(o.isMine).toBe(false)
    expect(o.tier).toBe('common')
    expect(o.adjacent).toBe(0)
  })

  it('revealing the opening clears exactly one tile (no flood-fill)', () => {
    const seed = 'open-seed'
    const board = truth(seed)
    const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
    const before = engine.snapshot().playerCharge
    const events = engine.reveal(board.opening)
    const cleared = events.filter(e => e.kind === 'tileCleared')
    expect(cleared).toHaveLength(1) // only the clicked tile — one tile per click
    const openingHp = tileAt(board, board.opening.x, board.opening.y)!.maxHp
    expect(engine.snapshot().playerCharge).toBe(before - openingHp)
  })
})

describe('boss', () => {
  it('is a single tough non-mine tile pinned to the board centre', () => {
    const board = truth('boss-seed')
    const cx = Math.floor(cfg.width / 2)
    const cy = Math.floor(cfg.height / 2)
    const center = tileAt(board, cx, cy)!
    expect(center.tier).toBe('boss')
    expect(center.isMine).toBe(false)
    expect(center.maxHp).toBeGreaterThanOrEqual(cfg.bands.boss.minHp)
    // Exactly one boss on the board.
    expect(board.tiles.filter(t => t.tier === 'boss')).toHaveLength(1)
    // Far tougher than any ramp tile.
    const rampMax = Math.max(...board.tiles.filter(t => t.tier !== 'boss').map(t => t.maxHp))
    expect(center.maxHp).toBeGreaterThan(rampMax)
  })
})

describe('clicking a mine arms it for free', () => {
  it('arms, shows charge, spends no charge', () => {
    const seed = 'mine-seed'
    const board = truth(seed)
    const mine = firstCovered(board, t => !!t?.isMine)
    const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
    const before = engine.snapshot().playerCharge
    const events = engine.reveal(mine)
    expect(events.some(e => e.kind === 'mineArmed')).toBe(true)
    expect(events.some(e => e.kind === 'playerChargeChanged')).toBe(false)
    expect(engine.snapshot().playerCharge).toBe(before)
    const view = engine.snapshot().tiles.find(t => t.coord.x === mine.x && t.coord.y === mine.y)!
    expect(view.state).toBe('armed')
    expect(view.mineCharge).toBe(1)
  })
})

describe('hidden state does not leak', () => {
  it('a covered mine looks identical to covered ground in a snapshot', () => {
    const engine = createEngine({ difficulty: DIFF, seed: 'leak-seed', now: () => 0 })
    const snap = engine.snapshot()
    // Every covered tile exposes only coord/tier/state — nothing distinguishes a mine.
    for (const t of snap.tiles) {
      if (t.state === 'covered') {
        expect(t.number).toBeUndefined()
        expect(t.mineCharge).toBeUndefined()
        expect(t.crack).toBeUndefined()
        expect(Object.keys(t).sort()).toEqual(['coord', 'state', 'tier'])
      }
    }
  })
})

describe('clean clear costs the hidden HP', () => {
  it('spends exactly the tile HP and reveals the number', () => {
    const seed = 'clear-seed'
    const board = truth(seed)
    // A non-mine, non-opening tile with adjacent>0 so it does not cascade.
    const target = firstCovered(
      board,
      t => !!t && !t.isMine && t.adjacent > 0 && !(t.x === board.opening.x && t.y === board.opening.y),
    )
    const truthTile = tileAt(board, target.x, target.y)!
    const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
    const before = engine.snapshot().playerCharge
    const events = engine.reveal(target)
    const cleared = events.find(e => e.kind === 'tileCleared')!
    expect(cleared.kind).toBe('tileCleared')
    if (cleared.kind === 'tileCleared') expect(cleared.chargeSpent).toBe(truthTile.maxHp)
    expect(engine.snapshot().playerCharge).toBe(before - truthTile.maxHp)
  })
})

describe('chip when unaffordable', () => {
  it('drains charge, cracks, and costs time once the pool is spent', () => {
    const seed = 'chip-drain'
    const board = truth(seed)
    // Click the toughest ground tiles (never mines, never the opening) in descending HP
    // order; charge runs out and the next unaffordable click chips.
    const tough = board.tiles
      .filter(t => !t.isMine && !(t.x === board.opening.x && t.y === board.opening.y))
      .sort((a, b) => b.maxHp - a.maxHp)
    const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
    let sawCrack = false
    for (const t of tough) {
      const timeBefore = engine.snapshot().timeRemaining
      const events = engine.reveal({ x: t.x, y: t.y })
      const cracked = events.find(e => e.kind === 'tileCracked')
      if (cracked) {
        sawCrack = true
        expect(events.some(e => e.kind === 'timePenalty')).toBe(true)
        expect(engine.snapshot().timeRemaining).toBeLessThan(timeBefore)
        const view = engine.snapshot().tiles.find(v => v.coord.x === t.x && v.coord.y === t.y)!
        expect(view.state).toBe('cracked')
        break
      }
    }
    expect(sawCrack).toBe(true)
  })

  it('escalates the time penalty on repeated chips', () => {
    const engine = createEngine({ difficulty: DIFF, seed: 'escalate', now: () => 0 })
    // Force charge to 0 by finding any unaffordable tile is fiddly; instead chip the same
    // idea via two broke clicks and compare penalties directly from events.
    const board = truth('escalate')
    const tough = board.tiles
      .filter(t => !t.isMine && !(t.x === board.opening.x && t.y === board.opening.y))
      .sort((a, b) => b.maxHp - a.maxHp)
    const penalties: number[] = []
    for (const t of tough) {
      const ev = engine.reveal({ x: t.x, y: t.y })
      for (const e of ev) if (e.kind === 'timePenalty') penalties.push(e.seconds)
      if (penalties.length >= 2) break
    }
    expect(penalties.length).toBeGreaterThanOrEqual(2)
    expect(penalties[1]!).toBeGreaterThan(penalties[0]!)
  })
})

describe('detonation', () => {
  it('converts mine charge to the player pool and removes the mine', () => {
    const seed = 'det-seed'
    const board = truth(seed)
    const mine = firstCovered(board, t => !!t?.isMine)
    const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
    engine.reveal(mine) // arm
    const before = engine.snapshot().playerCharge
    const events = engine.detonate(mine)
    expect(events.some(e => e.kind === 'mineDetonated')).toBe(true)
    expect(engine.snapshot().playerCharge).toBe(before + Math.round(1 * cfg.chargeConversion))
    const view = engine.snapshot().tiles.find(t => t.coord.x === mine.x && t.coord.y === mine.y)!
    expect(view.state).toBe('detonated')
  })

  it('decrements a cleared neighbour number when the mine leaves', () => {
    // Find a seed where a mine has a clearable non-mine neighbour with adjacent>0.
    for (let i = 0; i < 200; i++) {
      const seed = `dec-${i}`
      const board = truth(seed)
      const mine = board.tiles.find(t => t.isMine)
      if (!mine) continue
      const gnb = board.tiles.find(
        t =>
          !t.isMine &&
          t.adjacent > 0 &&
          Math.abs(t.x - mine.x) <= 1 &&
          Math.abs(t.y - mine.y) <= 1 &&
          t.maxHp <= cfg.startingCharge,
      )
      if (!gnb) continue
      const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
      engine.reveal({ x: mine.x, y: mine.y }) // arm the mine
      engine.reveal({ x: gnb.x, y: gnb.y }) // clear the neighbour, revealing its number
      const numBefore = engine.snapshot().tiles.find(t => t.coord.x === gnb.x && t.coord.y === gnb.y)!.number!
      const events = engine.detonate({ x: mine.x, y: mine.y })
      expect(events.some(e => e.kind === 'numberDecremented')).toBe(true)
      const numAfter = engine.snapshot().tiles.find(t => t.coord.x === gnb.x && t.coord.y === gnb.y)!.number!
      expect(numAfter).toBe(numBefore - 1)
      return
    }
    throw new Error('no suitable seed found for decrement test')
  })
})

describe('loss', () => {
  it('fires when the timer is exhausted', () => {
    const engine = createEngine({ difficulty: DIFF, seed: 'loss-seed', now: () => 0 })
    const events = engine.tick(cfg.timerSeconds + 1)
    expect(events.some(e => e.kind === 'gameLost')).toBe(true)
    expect(engine.snapshot().status).toBe('lost')
    const result = engine.result()!
    expect(result.outcome).toBe('lost')
    expect(result.score).toBe(0)
  })

  it('rejects further input after the game ends', () => {
    const engine = createEngine({ difficulty: DIFF, seed: 'loss-seed', now: () => 0 })
    engine.tick(cfg.timerSeconds + 1)
    expect(engine.reveal({ x: 0, y: 0 })).toEqual([])
    expect(engine.detonate({ x: 0, y: 0 })).toEqual([])
  })
})
