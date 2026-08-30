/**
 * Inner Land Minesweeper — engine type contract.
 *
 * This file is the single source of truth for the shape of the game. It has zero runtime
 * behaviour and zero framework imports: the UI layer, the harness, and the host site all
 * depend on these types and nothing else.
 *
 * Design reference: docs/GAME_DESIGN.md
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A tile's visible toughness band. The exact HP is hidden; only the tier is shown. */
export type Tier = 'light' | 'medium' | 'heavy' | 'elite'

/** Zero-based grid coordinate. */
export interface Coord {
  readonly x: number
  readonly y: number
}

export type Difficulty = 'gentle' | 'standard' | 'hard'

// ---------------------------------------------------------------------------
// Tile state
// ---------------------------------------------------------------------------

/**
 * What the *player* is allowed to know about a tile. The engine holds more than this
 * (true HP, whether ground hides a mine); a BoardSnapshot only ever exposes what the
 * board legitimately shows, so the UI cannot accidentally leak hidden state.
 */
export interface TileView {
  readonly coord: Coord
  /** Visible toughness band. Present for covered tiles too — including mines. */
  readonly tier: Tier
  readonly state: TileState
  /**
   * Adjacent-mine count. Present only once `state === 'cleared'`. Reflects mines that
   * are *currently* on the board — it decrements as neighbours detonate, and can reach 0.
   */
  readonly number?: number
  /** 0..1 crack progress for a chipped-but-not-cleared tile. Present only when cracked. */
  readonly crack?: number
  /** Charge multiplier, present only for an uncovered (armed) mine. */
  readonly mineCharge?: number
}

export type TileState =
  | 'covered' // untouched; shows a tier
  | 'cleared' // ground, revealed, shows a number
  | 'cracked' // ground, chipped but not yet cleared
  | 'armed' // a mine, uncovered, not yet detonated
  | 'detonated' // a mine that has gone off and left the board

// ---------------------------------------------------------------------------
// Board snapshot — the read model the UI renders
// ---------------------------------------------------------------------------

export interface BoardSnapshot {
  readonly width: number
  readonly height: number
  readonly tiles: readonly TileView[] // row-major, length width*height
  readonly playerCharge: number
  /** Seconds left on the fixed budget. Loss fires when this hits 0. */
  readonly timeRemaining: number
  readonly status: GameStatus
}

export type GameStatus = 'playing' | 'won' | 'lost'

// ---------------------------------------------------------------------------
// Events — the write model the UI animates
// ---------------------------------------------------------------------------

/**
 * Every mutating call returns an ordered EventList describing exactly what changed and
 * why. The UI consumes this to drive animation; it never diffs two snapshots. Events are
 * emitted in causal order (the click, then its cascade, then any resulting win/loss).
 */
export type GameEvent =
  | { kind: 'mineArmed'; coord: Coord; mineCharge: number; via: CauseOfArming }
  | { kind: 'tileCleared'; coord: Coord; number: number; cascadeDistance: number; chargeSpent: number }
  | { kind: 'tileCracked'; coord: Coord; crack: number; hpKnockedDown: number; chargeDrained: number }
  | { kind: 'mineDetonated'; coord: Coord; damage: number; radius: readonly Coord[] }
  | { kind: 'mineChargeChanged'; coord: Coord; from: number; to: number }
  | { kind: 'numberDecremented'; coord: Coord; from: number; to: number }
  | { kind: 'playerChargeChanged'; from: number; to: number }
  | { kind: 'timePenalty'; seconds: number; reason: 'crack' | 'chipGrind' }
  | { kind: 'chainLink'; depth: number } // one step of a detonation-triggered chain; max depth feeds maxChain
  | { kind: 'gameWon'; result: GameResult }
  | { kind: 'gameLost'; result: GameResult }

export type CauseOfArming = 'click' | 'blast'

export type EventList = readonly GameEvent[]

// ---------------------------------------------------------------------------
// Result — the handoff to the host (persistence, leaderboard)
// ---------------------------------------------------------------------------

/**
 * Emitted once, at end of game, inside a `gameWon`/`gameLost` event. This is the *entire*
 * contract between the game and any host: the game knows nothing about Appwrite, RxDB, or
 * domain bundles. A host catches this and does whatever it does.
 */
export interface GameResult {
  readonly seed: string
  readonly difficulty: Difficulty
  readonly outcome: 'won' | 'lost'
  readonly score: number
  readonly durationSeconds: number
  readonly timeRemaining: number
  readonly moves: number
  readonly detonations: number
  readonly maxChain: number
  readonly cracks: number
  readonly tilesCleared: number
  readonly boardClearedFraction: number
}

// ---------------------------------------------------------------------------
// Engine surface
// ---------------------------------------------------------------------------

export interface EngineOptions {
  readonly difficulty: Difficulty
  /** Deterministic seed. Same seed + same difficulty + same inputs → identical run. */
  readonly seed: string
  /** Injectable clock in seconds, for the headless harness. Defaults to wall time. */
  readonly now?: () => number
}

/**
 * The pure game core. No DOM, no framework, no I/O. Every mutating method returns the
 * events it produced; `snapshot()` returns the current read model on demand.
 */
export interface MinesweeperEngine {
  reveal(coord: Coord): EventList
  detonate(coord: Coord): EventList
  /** Advance the timer; the harness calls this explicitly, the UI on a rAF/interval tick. */
  tick(deltaSeconds: number): EventList
  snapshot(): BoardSnapshot
  result(): GameResult | null
}
