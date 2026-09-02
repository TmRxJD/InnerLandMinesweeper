/**
 * Board model and generation. Everything here is engine-internal — the UI never sees a
 * `Tile`, only the `TileView` projection built in engine.ts, so hidden state (true HP,
 * whether covered ground hides a mine) cannot leak.
 */

import type { Coord, Tier, TileState } from './types'
import type { DifficultyConfig } from './tuning'
import { Rng } from './rng'

// The toughness ramp for random ground. `boss` is excluded — it is placed once, at centre.
const TIER_ORDER: readonly Tier[] = ['common', 'advanced', 'elite', 'fleet']


export interface Tile {
  readonly x: number
  readonly y: number
  /** Mutable: a Magnetic Hook pull relocates the armed mine, flipping this on two cells. */
  isMine: boolean
  /** A Magnetic Hook bonus tile (never also a mine). Clearing it grants a hook charge. */
  isHook: boolean
  tier: Tier
   /** Hidden true HP, rolled within the tier's band. Damage reduces `hp`. */
  hp: number
  /** The HP a fresh clean-clear must meet or beat. Immutable; `hp` drops as it takes damage. */
  readonly maxHp: number
  state: TileState
  /** Mines only: charge multiplier, grows with overlapping blasts. */
  mineCharge: number
  /** Ground only: live adjacent-mine count, decrements as neighbours detonate. */
  adjacent: number
  /** True once a manual tap has revealed this tile's number. A blast-vaporised tile is
   *  cleared but leaves this false, so its number is never shown. */
  numberKnown: boolean
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
 *  - the Boss is pinned to the exact centre and is never a mine,
 *  - the opening sits in a corner (zero adjacent mines, safe first tap) so play routes
 *    outward → inward toward the Boss,
 *  - enough mines sit within blast reach of the centre that the Boss is always killable by
 *    blasts (not only by the slow hand-tap fallback),
 *  - sprite tiers clump via a smooth hardness field (cosmetic only — every non-boss tile is
 *    1 HP regardless of tier).
 */
export function generateBoard(cfg: DifficultyConfig, seed: string): Board {
  const rng = new Rng(seed)
  const { width, height } = cfg
  const total = width * height

  // The boss is pinned to the exact board centre and is never a mine.
  const boss: Coord = { x: Math.floor(width / 2), y: Math.floor(height / 2) }
  const bossIdx = idx(width, boss.x, boss.y)

  // Opening: a corner cell (one step in from the true corner so its neighbourhood is on-board),
  // chosen at random among the four. Starting at a corner pushes the natural route inward.
  const corners: Coord[] = [
    { x: 1, y: 1 },
    { x: width - 2, y: 1 },
    { x: 1, y: height - 2 },
    { x: width - 2, y: height - 2 },
  ]
  const opening = corners[rng.int(0, corners.length - 1)]!

  const reserved = new Set<number>()
  reserved.add(bossIdx) // no mine on the boss
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

  // Mines are ONE scarce pool, spent on BOTH clearing ground and killing the Boss — there are no
  // reserved "killer" mines. Scatter `mineCount` of them anywhere off the reserved cells, never
  // touching (stacks are built by play, not spawned adjacent). How you divide them between the field
  // and the Boss is the whole game: blast away too many clearing and the mines left can't finish the
  // kill — the engine calls that run lost (see bossStillKillable). `mineCount` is tuned so a good
  // allocation wins and a greedy one runs itself dry.
  const mineCells = new Set<number>()
  const touchesMine = (i: number): boolean => {
    const x = i % width
    const y = (i / width) | 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if ((dx || dy) && x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && mineCells.has(idx(width, x + dx, y + dy))) return true
    return false
  }
  // A Boss-free moat: no mine spawns within (blastRadiusCap + 1) of the Boss — just out of reach of
  // even a max-stack blast's +1 rule — so NO mine can hit the Boss where it lies. To land the kill
  // you MUST hook mines across the moat into range. Hooks aren't a nicety, they're the only delivery.
  const bossFree = cfg.blastRadiusCap + 1
  const cells: number[] = []
  for (let i = 0; i < total; i++) {
    if (reserved.has(i)) continue
    const cheb = Math.max(Math.abs((i % width) - boss.x), Math.abs(((i / width) | 0) - boss.y))
    if (cheb <= bossFree) continue
    cells.push(i)
  }
  rng.shuffle(cells)
  for (const i of cells) {
    if (mineCells.size >= cfg.mineCount) break
    if (!touchesMine(i)) mineCells.add(i)
  }

  const hardness = buildHardnessField(rng, width, height)

  const tiles: Tile[] = new Array(total)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(width, x, y)
      const isMine = mineCells.has(i)

      // Tier is cosmetic — it only picks which enemy sprite shows. HP is always 1.
      let tier: Tier = rng.weighted(cfg.tierWeights)
      const h = hardness(x, y)
      if (rng.chance(cfg.hardGroundGradient * h)) tier = upgradeTier(tier, rng.chance(0.2) ? 2 : 1)

      tiles[i] = {
        x,
        y,
        isMine,
        isHook: false,
        tier,
        hp: 1,
        maxHp: 1,
        state: 'covered',
        mineCharge: isMine ? 1 : 0,
        adjacent: 0,
        numberKnown: false,
      }
    }
  }

  // Magnetic Hook bonus tiles: placed on non-mine ground in the OUTER rings only (never the
  // centre region), so you earn pulls by clearing outward — you can't tap around the boss to
  // farm them. Low density; visible while covered so you can route to them.
  const outerMin = cfg.blastRadiusCap + 2 // keep hooks clear of the centre/boss region
  const hookCandidates: number[] = []
  for (const t of tiles) {
    if (t.isMine || t.tier === 'boss') continue
    if (t.x === opening.x && t.y === opening.y) continue
    if (Math.max(Math.abs(t.x - boss.x), Math.abs(t.y - boss.y)) < outerMin) continue
    hookCandidates.push(idx(width, t.x, t.y))
  }
  rng.shuffle(hookCandidates)
  for (let i = 0; i < Math.min(cfg.hookCount, hookCandidates.length); i++) {
    tiles[hookCandidates[i]!]!.isHook = true
  }

  // Pin the boss: the single multi-hit tile at centre — the end-game problem.
  const bossTile = tiles[bossIdx]!
  ;(bossTile as { tier: Tier }).tier = 'boss'
  bossTile.hp = cfg.bossHp
  ;(bossTile as { maxHp: number }).maxHp = cfg.bossHp

  // Adjacency counts for ground tiles.
  const board: Board = { width, height, tiles, opening, mineCount: mineCells.size }
  for (const t of tiles) {
    if (t.isMine) continue
    t.adjacent = neighbours(board, t.x, t.y).filter(n => n.isMine).length
  }

  return board
}
