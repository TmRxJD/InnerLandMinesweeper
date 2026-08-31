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
  Medal,
} from './types'

export { DIFFICULTIES, blastRadiusForStack, medalForTime } from './tuning'
export type { DifficultyConfig } from './tuning'
