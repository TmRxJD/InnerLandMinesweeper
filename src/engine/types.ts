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

/**
 * A tile's visible enemy class (The Tower's real enemy categories). The exact HP is hidden;
 * only the class is shown. common → advanced → elite → fleet ramp in toughness; `boss` is a
 * single, far tougher tile pinned to the board centre.
 *   common:   Basic, Fast, Tank
 *   advanced: Ranged, Protector
 *   elite:    Vampire, Ray, Scatter
 *   fleet:    Saboteur, Commander, Overcharge
 */
export type Tier = 'common' | 'advanced' | 'elite' | 'fleet' | 'boss'

/** Zero-based grid coordinate. */
export interface Coord {
  readonly x: number
  readonly y: number
}

export type Difficulty = 'gentle' | 'standard' | 'hard'

/** Medal earned for a clear time (see tuning thresholds). */
export type Medal = 'gold' | 'silver' | 'bronze' | 'none'

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
   * Adjacent-mine count. Present only for a tile cleared by a *manual* click or cascade —
   * never for a blast-vaporised tile, whose number stays unknown. Reflects mines that are
   * *currently* on the board: it decrements as neighbours detonate, and can reach 0.
   */
  readonly number?: number
  /** 0..1 crack progress for a chipped-but-not-cleared tile. Present only when cracked. */
  readonly crack?: number
  /** Charge multiplier, present only for an uncovered (armed) mine. */
  readonly mineCharge?: number
  /** True for a still-covered Magnetic Hook tile — a visible bonus you can route to. Clearing
   *  it grants a hook charge. Never set on a mine (hooks are always non-mine tiles). */
  readonly isHook?: boolean
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
  /** Elapsed seconds — a stopwatch, the score. It only counts up; there is no loss timer. */
  readonly timeElapsed: number
  /** Total player actions taken so far (reveals + detonations). */
  readonly moves: number
  readonly status: GameStatus
  /** Current / starting Boss HP — for the HUD boss bar. */
  readonly bossHp: number
  readonly bossMaxHp: number
  /** Current / starting Boss shield — the buffer that absorbs blast damage before HP and regrows
   *  when the Boss is left alone. Shown as a layer on the boss bar. */
  readonly bossShield: number
  readonly bossShieldMax: number
  /** Held Magnetic Hook charges — spend one to pull an armed mine a tile toward the Boss. */
  readonly hookCharges: number
  /** Caps for this difficulty, so a strategy layer (bot / UI) can reason about stacks & reach. */
  readonly stackCap: number
  readonly blastRadiusCap: number
  /** How much a detonation pumps a neighbouring mine's stack, per point of the DETONATOR's stack
   *  (via `overlapBoost`). The strategy layer needs it to predict how fat a chain becomes. */
  readonly overlapBoostPerStack: number
  /** Chebyshev radius of the "near-Boss" zone: the mines inside it are the killers to gather into
   *  the blob; everything past it is field ordnance. Generation and the strategy layer share it. */
  readonly gatherRadius: number
  /** Mines not yet detonated (your remaining ammo). Positions stay hidden — this is just the count,
   *  like classic Minesweeper's mine counter — so you can budget how many to spend clearing vs. save
   *  for the Boss without being told where they are. */
  readonly minesRemaining: number
}

// Mines are one scarce pool spent on BOTH clearing and the Boss, so bad allocation is fatal: 'lost'
// fires the moment the Boss can no longer be killed with the mines you have left.
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
  | { kind: 'tileCleared'; coord: Coord; number: number; chargeSpent: number }
  // A blast vaporises a tile: it counts as cleared, but its number is never revealed —
  // information stays tied to risky manual taps, and blasts stay free of info leakage.
  // `from` is set only for a SHRAPNEL kill (an enemy just outside the blast, struck by the
  // detonation at `from`) so the UI can draw a distinct tracer; radius-vaporised tiles omit it.
  | { kind: 'tileDestroyed'; coord: Coord; from?: Coord }
  // A tile took partial damage (hand-chip under HP, or a blast that didn't finish it); the
  // HP bar reflects `crack` (0..1).
  | { kind: 'tileCracked'; coord: Coord; crack: number }
  | { kind: 'mineDetonated'; coord: Coord; intensity: number; radius: readonly Coord[] }
  | { kind: 'mineChargeChanged'; coord: Coord; from: number; to: number }
  | { kind: 'numberDecremented'; coord: Coord; from: number; to: number }
  // A cleared number went up because a mine was hooked into range (numbers stay honest).
  | { kind: 'numberIncremented'; coord: Coord; from: number; to: number }
  | { kind: 'playerChargeChanged'; from: number; to: number }
  // A Magnetic Hook tile was collected (charge gained), or a charge was spent to pull a mine.
  | { kind: 'hookCharged'; coord: Coord; to: number }
  | { kind: 'hookUsed'; from: Coord; to: Coord; charges: number }
  // The Boss shield changed — absorbed a hit (to < from) or regrew from neglect (to > from).
  | { kind: 'bossShieldChanged'; from: number; to: number }
  | { kind: 'gameWon'; result: GameResult }
  // The Boss can no longer be killed with the mines left on the board — the run is lost.
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
  /** 'won' = field cleared and Boss dead; 'lost' = ran the mine pool dry, OR the countdown to your
   *  best time hit zero (see `timedOut`). */
  readonly outcome: 'won' | 'lost'
  /** True when the loss was the speedrun clock running out (couldn't beat your best time) rather than
   *  running out of mines. */
  readonly timedOut: boolean
  /** Higher is better: how much of par you beat, scaled by difficulty. */
  readonly score: number
  /** The real metric — clear time in whole seconds (lower is better). */
  readonly timeSeconds: number
  readonly medal: Medal
  readonly moves: number
  readonly detonations: number
  readonly tilesCleared: number
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
  /** DEV/testing only: when true, covered Magnetic Hook tiles expose `isHook` in snapshots so
   *  a debug view can mark them. Off in normal play — hooks are a discovery, not a signpost. */
  readonly revealHooks?: boolean
  /** Speedrun target: the time (seconds) to beat — your previous best. The clock counts DOWN from
   *  it; reach it before winning and the run is lost ('too slow'). Omit for a free, untimed run
   *  (e.g. your first game, which just sets the baseline). */
  readonly targetSeconds?: number
}

/**
 * The pure game core. No DOM, no framework, no I/O. Every mutating method returns the
 * events it produced; `snapshot()` returns the current read model on demand.
 */
export interface MinesweeperEngine {
  reveal(coord: Coord): EventList
  detonate(coord: Coord): EventList
  /** Spend one Magnetic Hook charge to move the armed mine at `coord` one tile in `dir` (any of
   *  the 8 directions; each of dir.x/dir.y is used as its sign, −1..1). It crushes a 1-HP enemy
   *  in the way; no-op (empty list) with no charge, no armed mine there, a zero direction, or a
   *  target that is another mine, the Boss, or off-grid. */
  useHook(coord: Coord, dir: Coord): EventList
  /** Advance the timer; the harness calls this explicitly, the UI on a rAF/interval tick. */
  tick(deltaSeconds: number): EventList
  snapshot(): BoardSnapshot
  result(): GameResult | null
  /** A deep, independent copy of the current game state. The planning AI (MCTS) clones the live
   *  game, plays hypothetical moves on the copy to see how they turn out, and throws it away — the
   *  real game is never touched. */
  clone(): MinesweeperEngine
}
