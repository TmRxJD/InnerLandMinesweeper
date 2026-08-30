/**
 * Public engine surface. The UI layer and any host import from here and nowhere deeper.
 *
 * The concrete engine implementation is not written yet — this barrel currently exports
 * only the type contract and tuning. `createEngine` lands next.
 */

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
