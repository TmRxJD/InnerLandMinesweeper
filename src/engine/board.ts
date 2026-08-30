/**
 * Board model and generation. Everything here is engine-internal — the UI never sees a
 * `Tile`, only the `TileView` projection built in engine.ts, so hidden state (true HP,
 * whether covered ground hides a mine) cannot leak.
 */

import type { Coord, Tier, TileState } from './types'
import type { DifficultyConfig } from './tuning'
import { Rng } from './rng'

const TIER_ORDER: readonly Tier[] = ['light', 'medium', 'heavy', 'elite']

export interface Tile {
  readonly x: number
  readonly y: number
  readonly isMine: boolean
  tier: Tier
  /** Hidden true HP, rolled within the tier's band. Chipping reduces `hp`. */
  hp: number
  /** The HP a fresh clean-clear must meet or beat. Immutable; `hp` drops as it's chipped. */
  readonly maxHp: number
  state: TileState
  /** Mines only: charge multiplier, grows with overlapping blasts. */
  mineCharge: number
  /** Ground only: live adjacent-mine count, decrements as neighbours detonate. */
  adjacent: number
  /** True once a manual clear/cascade has revealed this tile's number. A blast-vaporised
   *  tile is cleared but leaves this false, so its number is never shown. */
  numberKnown: boolean
  /** How many times this tile has been chipped — drives the escalating time penalty. */
  crackCount: number
}

export interface Board {
  readonly width: number
  readonly height: number
  readonly tiles: Tile[] // row-major
  readonly opening: Coord
  readonly mineCount: number
}

export function idx(width: number, x: number, y: number): number {
  return y * width + x
}

export function inBounds(board: Pick<Board, 'width' | 'height'>, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < board.width && y < board.height
}

export function tileAt(board: Board, x: number, y: number): Tile | undefined {
  if (!inBounds(board, x, y)) return undefined
  return board.tiles[idx(board.width, x, y)]
}

/** 8-neighbourhood (Moore). */
export function neighbours(board: Board, x: number, y: number): Tile[] {
  const out: Tile[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const t = tileAt(board, x + dx, y + dy)
      if (t) out.push(t)
    }
  }
  return out
}

/** Cells within Chebyshev `radius` of centre, excluding the centre itself. */
export function withinRadius(board: Board, x: number, y: number, radius: number): Tile[] {
  const out: Tile[] = []
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue
      const t = tileAt(board, x + dx, y + dy)
      if (t) out.push(t)
    }
  }
  return out
}

interface HardCenter {
  cx: number
  cy: number
  scale: number
}

function buildHardnessField(rng: Rng, width: number, height: number): (x: number, y: number) => number {
  const count = 2 + rng.int(0, 2)
  const centers: HardCenter[] = []
  const maxDim = Math.max(width, height)
  for (let i = 0; i < count; i++) {
    centers.push({
      cx: rng.int(0, width - 1),
      cy: rng.int(0, height - 1),
      scale: maxDim * (0.18 + rng.float() * 0.22),
    })
  }
  return (x: number, y: number) => {
    let h = 0
    for (const c of centers) {
      const d2 = (x - c.cx) ** 2 + (y - c.cy) ** 2
      h += Math.exp(-d2 / (2 * c.scale * c.scale))
    }
    return Math.min(1, h)
  }
}

function upgradeTier(tier: Tier, steps: number): Tier {
  const i = TIER_ORDER.indexOf(tier)
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, i + steps)]!
}

/**
 * Generate a board. Guarantees:
 *  - the opening cell is Light with zero adjacent mines (a free opening cascade),
 *  - mines never sit in the opening's 8-neighbourhood (so its count is genuinely 0),
 *  - tough tiles cluster via a smooth hardness field scaled by `hardGroundGradient`.
 */
export function generateBoard(cfg: DifficultyConfig, seed: string): Board {
  const rng = new Rng(seed)
  const { width, height } = cfg
  const total = width * height

  // Opening: an interior cell so its full neighbourhood exists on-board.
  const opening: Coord = {
    x: rng.int(1, Math.max(1, width - 2)),
    y: rng.int(1, Math.max(1, height - 2)),
  }

  const reserved = new Set<number>()
  reserved.add(idx(width, opening.x, opening.y))
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = opening.x + dx
      const ny = opening.y + dy
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
        reserved.add(idx(width, nx, ny))
      }
    }
  }

  // Mine placement: shuffle all non-reserved cells, take the first N.
  const mineCount = Math.round(cfg.mineDensity * total)
  const candidates: number[] = []
  for (let i = 0; i < total; i++) {
    if (!reserved.has(i)) candidates.push(i)
  }
  rng.shuffle(candidates)
  const mineCells = new Set(candidates.slice(0, Math.min(mineCount, candidates.length)))

  const hardness = buildHardnessField(rng, width, height)

  const tiles: Tile[] = new Array(total)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const isMine = mineCells.has(i)

      let tier: Tier = rng.weighted(cfg.tierWeights)
      const h = hardness(x, y)
      if (rng.chance(cfg.hardGroundGradient * h)) {
        tier = upgradeTier(tier, rng.chance(0.4) ? 2 : 1)
      }

      const band = cfg.bands[tier]
      const hp = rng.int(band.minHp, band.maxHp)

      tiles[i] = {
        x,
        y,
        isMine,
        tier,
        hp,
        maxHp: hp,
        state: 'covered',
        mineCharge: isMine ? 1 : 0,
        adjacent: 0,
        numberKnown: false,
        crackCount: 0,
      }
    }
  }

  // Force the opening tile to Light regardless of what it rolled.
  const openTile = tiles[idx(width, opening.x, opening.y)]!
  if (openTile.tier !== 'light') {
    const band = cfg.bands.light
    ;(openTile as { tier: Tier }).tier = 'light'
    openTile.hp = rng.int(band.minHp, band.maxHp)
    ;(openTile as { maxHp: number }).maxHp = openTile.hp
  }

  // Adjacency counts for ground tiles.
  const board: Board = { width, height, tiles, opening, mineCount: mineCells.size }
  for (const t of tiles) {
    if (t.isMine) continue
    t.adjacent = neighbours(board, t.x, t.y).filter(n => n.isMine).length
  }

  return board
}
