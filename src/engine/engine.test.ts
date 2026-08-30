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

describe('tapping tiles', () => {
  it('only Common (and Boss) tiles can be tapped; tougher tiles are shielded', () => {
    const seed = 'shield-seed'
    const board = truth(seed)
    const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
    // A tough (Advanced/Elite/Fleet) ground tile that isn't a mine or the opening.
    const tough = board.tiles.find(
      t => !t.isMine && (t.tier === 'advanced' || t.tier === 'elite' || t.tier === 'fleet'),
    )
    expect(tough).toBeDefined()
    const before = engine.snapshot()
    const events = engine.reveal({ x: tough!.x, y: tough!.y })
    expect(events.some(e => e.kind === 'tileShielded')).toBe(true)
    // No state change, no charge spent — a mine blast is the only thing that damages it.
    const view = engine.snapshot().tiles.find(v => v.coord.x === tough!.x && v.coord.y === tough!.y)!
    expect(view.state).toBe('covered')
    expect(engine.snapshot().playerCharge).toBe(before.playerCharge)
  })

  it('the Boss chips (partial damage, no time penalty) when tapped under-charged', () => {
    // Boss is at centre with HP far above the charge pool, so a tap always chips it.
    const seed = 'boss-chip'
    const engine = createEngine({ difficulty: DIFF, seed, now: () => 0 })
    const cx = Math.floor(cfg.width / 2)
    const cy = Math.floor(cfg.height / 2)
    const timeBefore = engine.snapshot().timeRemaining
    const events = engine.reveal({ x: cx, y: cy })
    expect(events.some(e => e.kind === 'tileCracked')).toBe(true)
    expect(engine.snapshot().timeRemaining).toBe(timeBefore) // tapping costs no time
    expect(engine.snapshot().playerCharge).toBe(0) // charge spent as damage
    const view = engine.snapshot().tiles.find(v => v.coord.x === cx && v.coord.y === cy)!
    expect(view.state).toBe('cracked')
    expect(view.crack).toBeGreaterThan(0) // HP bar reflects the damage
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
