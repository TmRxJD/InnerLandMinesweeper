/**
 * The concrete engine. Pure: no DOM, no framework, no wall-clock unless you let it.
 *
 * Charge is a damage currency. A clean clear costs a ground tile's hidden HP; when you
 * can't pay it in full the click chips instead — partial damage, a drained pool, and an
 * escalating time penalty. Detonating an armed mine converts its charge into your pool.
 * Every mutating method returns the ordered events it produced. See docs/GAME_DESIGN.md.
 */

import type {
  BoardSnapshot,
  Coord,
  Difficulty,
  EngineOptions,
  EventList,
  GameEvent,
  GameResult,
  GameStatus,
  MinesweeperEngine,
  TileView,
} from './types'
import { DIFFICULTIES, SCORE_CHAIN_WEIGHT, SCORE_CRACK_WEIGHT, type DifficultyConfig } from './tuning'
import {
  generateBoard,
  neighbours,
  tileAt,
  withinRadius,
  type Board,
  type Tile,
} from './board'

class Engine implements MinesweeperEngine {
  private readonly cfg: DifficultyConfig
  private readonly board: Board
  private readonly difficulty: Difficulty
  private readonly seed: string
  private readonly clock: () => number

  private playerCharge: number
  private timeRemaining: number
  private status: GameStatus = 'playing'
  private readonly startedAt: number

  private moves = 0
  private detonations = 0
  private cracks = 0
  private chipsSoFar = 0
  private maxChain = 0
  private tilesCleared = 0
  private readonly groundTotal: number
  private finalResult: GameResult | null = null

  constructor(opts: EngineOptions) {
    this.cfg = DIFFICULTIES[opts.difficulty]
    this.difficulty = opts.difficulty
    this.seed = opts.seed
    this.clock = opts.now ?? (() => Date.now() / 1000)
    this.board = generateBoard(this.cfg, opts.seed)
    this.playerCharge = this.cfg.startingCharge
    this.timeRemaining = this.cfg.timerSeconds
    this.startedAt = this.clock()
    this.groundTotal = this.board.tiles.filter(t => !t.isMine).length
  }

  // -- public surface ------------------------------------------------------

  reveal(coord: Coord): EventList {
    if (this.status !== 'playing') return []
    const tile = tileAt(this.board, coord.x, coord.y)
    if (!tile) return []
    // Already-resolved tiles are no-ops; cracked ground can be clicked again.
    if (tile.state === 'cleared' || tile.state === 'armed' || tile.state === 'detonated') return []

    this.moves++
    const events: GameEvent[] = []

    if (tile.isMine) {
      this.armMine(tile, 'click', events)
      this.checkWin(events)
      return events
    }

    this.clickGround(tile, events)
    return events
  }

  detonate(coord: Coord): EventList {
    if (this.status !== 'playing') return []
    const tile = tileAt(this.board, coord.x, coord.y)
    if (!tile || tile.state !== 'armed') return []

    this.moves++
    this.detonations++
    const events: GameEvent[] = []
    let chainCleared = 0

    // 1. Convert this mine's charge into the player pool.
    const gained = Math.round(tile.mineCharge * this.cfg.chargeConversion)
    if (gained !== 0) this.setPlayerCharge(this.playerCharge + gained, events)

    // 2. The mine leaves the board.
    const damage = this.cfg.blastBaseDamage * tile.mineCharge
    const radiusTiles = withinRadius(this.board, tile.x, tile.y, this.cfg.blastRadius)
    tile.state = 'detonated'
    events.push({
      kind: 'mineDetonated',
      coord: { x: tile.x, y: tile.y },
      damage,
      radius: radiusTiles.map(t => ({ x: t.x, y: t.y })),
    })

    // 3. Removing the mine decrements neighbours' live counts; any cleared number that
    //    hits zero unzips a free Light cascade.
    chainCleared += this.decrementAround(tile, events)

    // 4. Apply blast damage. Track which ground cells this blast *cleared* — overlap
    //    charging keys off cleared ground, not merely damaged ground.
    const clearedByBlast: Tile[] = []
    for (const t of radiusTiles) {
      if (t.isMine) {
        if (t.state === 'covered') this.armMine(t, 'blast', events)
        continue
      }
      if (t.state === 'cleared') continue
      t.hp -= damage
      if (t.hp <= 0) {
        // Vaporised by the blast: cleared, but its number is never revealed and it does
        // not seed a cascade. Information stays tied to risky manual clicks.
        this.destroyGroundTile(t, events)
        clearedByBlast.push(t)
        chainCleared += 1
      } else {
        this.chipTile(t, damage, events, /*charge already spent*/ false)
      }
    }

    // 5. Overlap charging: every other armed mine whose radius covers ground this blast
    //    cleared gains charge.
    if (clearedByBlast.length > 0) this.chargeOverlappingMines(tile, clearedByBlast, events)

    if (chainCleared > this.maxChain) this.maxChain = chainCleared
    if (chainCleared > 0) events.push({ kind: 'chainLink', depth: chainCleared })

    this.checkWin(events)
    return events
  }

  tick(deltaSeconds: number): EventList {
    if (this.status !== 'playing' || deltaSeconds <= 0) return []
    const events: GameEvent[] = []
    this.spendTime(deltaSeconds, events)
    return events
  }

  snapshot(): BoardSnapshot {
    return {
      width: this.board.width,
      height: this.board.height,
      tiles: this.board.tiles.map(t => this.view(t)),
      playerCharge: this.playerCharge,
      timeRemaining: this.timeRemaining,
      status: this.status,
    }
  }

  result(): GameResult | null {
    return this.finalResult
  }

  // -- ground clicks -------------------------------------------------------

  private clickGround(tile: Tile, events: GameEvent[]): void {
    if (this.playerCharge >= tile.hp) {
      // Clean clear: pay the tile's full (hidden) HP.
      const cost = tile.hp
      this.setPlayerCharge(this.playerCharge - cost, events)
      this.clearGroundTile(tile, cost, events)
      const cascaded = this.cascadeFrom(tile, events)
      if (cascaded > this.maxChain) this.maxChain = cascaded
      this.checkWin(events)
      return
    }

    // Chip: spend whatever charge remains as partial damage. A broke player (0 charge)
    // deals nothing but still burns time — this is what makes blind-probing lose.
    const damage = this.playerCharge
    if (damage > 0) {
      tile.hp -= damage
      this.setPlayerCharge(0, events)
    }
    this.chipTile(tile, damage, events, /*chargeAlreadySpent*/ true)
    this.checkWin(events)
  }

  private chipTile(tile: Tile, damage: number, events: GameEvent[], chargeAlreadySpent: boolean): void {
    tile.crackCount++
    this.cracks++
    if (tile.state !== 'cracked') tile.state = 'cracked'
    const crack = Math.max(0, Math.min(1, 1 - tile.hp / tile.maxHp))
    events.push({
      kind: 'tileCracked',
      coord: { x: tile.x, y: tile.y },
      crack,
      hpKnockedDown: damage,
      chargeDrained: chargeAlreadySpent ? damage : 0,
    })
    // Linear, capped time penalty keyed on the running chip count across the whole game:
    // one honest mistake is cheap, sustained blind-probing compounds toward the cap.
    const penalty = Math.min(
      this.cfg.crackPenaltyCap,
      this.cfg.crackTimePenalty + this.cfg.crackPenaltyGrowth * this.chipsSoFar,
    )
    this.chipsSoFar++
    events.push({ kind: 'timePenalty', seconds: penalty, reason: this.playerCharge === 0 && damage === 0 ? 'chipGrind' : 'crack' })
    this.spendTime(penalty, events)
  }

  private clearGroundTile(tile: Tile, chargeSpent: number, events: GameEvent[]): void {
    tile.state = 'cleared'
    tile.numberKnown = true
    tile.hp = 0
    this.tilesCleared++
    events.push({
      kind: 'tileCleared',
      coord: { x: tile.x, y: tile.y },
      number: tile.adjacent,
      cascadeDistance: 0,
      chargeSpent,
    })
  }

  private destroyGroundTile(tile: Tile, events: GameEvent[]): void {
    tile.state = 'cleared'
    tile.numberKnown = false
    tile.hp = 0
    this.tilesCleared++
    events.push({ kind: 'tileDestroyed', coord: { x: tile.x, y: tile.y } })
  }

  // -- cascades ------------------------------------------------------------

  /**
   * Free, Light-only flood from a just-cleared zero-adjacent tile. Reveals covered Light
   * ground neighbours; continues only through Light tiles that are themselves zero.
   * Returns the number of tiles cleared by the cascade.
   */
  private cascadeFrom(origin: Tile, events: GameEvent[]): number {
    if (origin.adjacent !== 0) return 0
    let count = 0
    const queue: Array<{ tile: Tile; dist: number }> = [{ tile: origin, dist: 0 }]
    const seen = new Set<Tile>([origin])
    while (queue.length > 0) {
      const { tile, dist } = queue.shift()!
      for (const n of neighbours(this.board, tile.x, tile.y)) {
        if (seen.has(n)) continue
        if (n.isMine) continue
        if (n.tier !== 'light') continue
        if (n.state === 'cleared') continue
        seen.add(n)
        n.state = 'cleared'
        n.numberKnown = true
        n.hp = 0
        this.tilesCleared++
        count++
        events.push({
          kind: 'tileCleared',
          coord: { x: n.x, y: n.y },
          number: n.adjacent,
          cascadeDistance: dist + 1,
          chargeSpent: 0,
        })
        if (n.adjacent === 0) queue.push({ tile: n, dist: dist + 1 })
      }
    }
    return count
  }

  // -- detonation helpers --------------------------------------------------

  private armMine(tile: Tile, via: 'click' | 'blast', events: GameEvent[]): void {
    tile.state = 'armed'
    events.push({
      kind: 'mineArmed',
      coord: { x: tile.x, y: tile.y },
      mineCharge: tile.mineCharge,
      via,
    })
  }

  /** Decrement every ground neighbour's live count; zero-hitting cleared tiles cascade. */
  private decrementAround(mine: Tile, events: GameEvent[]): number {
    let cleared = 0
    for (const n of neighbours(this.board, mine.x, mine.y)) {
      if (n.isMine) continue
      if (n.adjacent <= 0) continue
      const from = n.adjacent
      n.adjacent--
      // Only a *known* number is visible, so only it can decrement on screen and only it
      // can hit zero and unzip a cascade. A vaporised tile has no number to change.
      if (n.state === 'cleared' && n.numberKnown) {
        events.push({ kind: 'numberDecremented', coord: { x: n.x, y: n.y }, from, to: n.adjacent })
        if (n.adjacent === 0) cleared += this.cascadeFrom(n, events)
      }
    }
    return cleared
  }

  private chargeOverlappingMines(source: Tile, clearedGround: Tile[], events: GameEvent[]): void {
    const clearedSet = new Set(clearedGround)
    for (const other of this.board.tiles) {
      if (other === source) continue
      if (other.state !== 'armed') continue
      const covers = withinRadius(this.board, other.x, other.y, this.cfg.blastRadius)
      if (covers.some(c => clearedSet.has(c))) {
        const from = other.mineCharge
        other.mineCharge += this.cfg.chargeGainPerOverlap
        events.push({ kind: 'mineChargeChanged', coord: { x: other.x, y: other.y }, from, to: other.mineCharge })
      }
    }
  }

  // -- resources & end state ----------------------------------------------

  private setPlayerCharge(next: number, events: GameEvent[]): void {
    const from = this.playerCharge
    const clamped = Math.max(0, next)
    if (clamped === from) return
    this.playerCharge = clamped
    events.push({ kind: 'playerChargeChanged', from, to: clamped })
  }

  private spendTime(seconds: number, events: GameEvent[]): void {
    this.timeRemaining = Math.max(0, this.timeRemaining - seconds)
    if (this.timeRemaining <= 0 && this.status === 'playing') {
      this.endGame('lost', events)
    }
  }

  private checkWin(events: GameEvent[]): void {
    if (this.status !== 'playing') return
    for (const t of this.board.tiles) {
      if (t.state === 'covered' || t.state === 'cracked') return
    }
    this.endGame('won', events)
  }

  private endGame(outcome: 'won' | 'lost', events: GameEvent[]): void {
    this.status = outcome === 'won' ? 'won' : 'lost'
    const result = this.buildResult(outcome)
    this.finalResult = result
    events.push({ kind: outcome === 'won' ? 'gameWon' : 'gameLost', result })
  }

  private buildResult(outcome: 'won' | 'lost'): GameResult {
    const duration = Math.max(0, this.clock() - this.startedAt)
    const base = this.timeRemaining * this.cfg.scoreDifficultyMultiplier
    const raw = base + SCORE_CHAIN_WEIGHT * this.maxChain - SCORE_CRACK_WEIGHT * this.cracks
    const score = outcome === 'won' ? Math.max(0, Math.round(raw)) : 0
    return {
      seed: this.seed,
      difficulty: this.difficulty,
      outcome,
      score,
      durationSeconds: Math.round(duration),
      timeRemaining: Math.round(this.timeRemaining),
      moves: this.moves,
      detonations: this.detonations,
      maxChain: this.maxChain,
      cracks: this.cracks,
      tilesCleared: this.tilesCleared,
      boardClearedFraction: this.groundTotal === 0 ? 1 : this.tilesCleared / this.groundTotal,
    }
  }

  // -- projection ----------------------------------------------------------

  private view(t: Tile): TileView {
    const base = { coord: { x: t.x, y: t.y }, tier: t.tier, state: t.state }
    switch (t.state) {
      case 'cleared':
        // A vaporised tile is cleared but never shows a number.
        return t.numberKnown ? { ...base, number: t.adjacent } : base
      case 'cracked':
        return { ...base, crack: Math.max(0, Math.min(1, 1 - t.hp / t.maxHp)) }
      case 'armed':
        return { ...base, mineCharge: t.mineCharge }
      default:
        return base
    }
  }
}

export function createEngine(opts: EngineOptions): MinesweeperEngine {
  return new Engine(opts)
}
