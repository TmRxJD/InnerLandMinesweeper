/**
 * Public engine surface. The UI layer and any host import from here and nowhere deeper.
 */

export { createEngine } from './engine'
export { randomSeed } from './rng'

export type {
  Tier,
  Coord,
  Difficulty,
  TileView,
  TileState,
  BoardSnapshot,
  GameStatus,
  GameEvent,
  CauseOfArming,
  EventList,
  GameResult,
  EngineOptions,
  MinesweeperEngine,
} from './types'

export { DIFFICULTIES, SCORE_CHAIN_WEIGHT, SCORE_CRACK_WEIGHT } from './tuning'
export type { DifficultyConfig, TierBand } from './tuning'
