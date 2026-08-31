/**
 * The concrete engine. Pure: no DOM, no framework, no wall-clock unless you let it.
 *
 * Charge is a damage currency. Tapping clears Commons (and grinds the Boss); tougher tiles
 * take slow hand-chips; a mine blast clears them fast. Detonating an armed mine converts its
 * charge into your (capped) pool.
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
  private regenAccum = 0
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

    // 2. The mine leaves the board. Blast damage per tile is a FRACTION of its max HP
    //    (so small tiles clear), but the absolute removal is CAPPED (so a fraction of a huge
    //    HP pool can't gut a Fleet — a 1× blast barely dents one). Charge multiplies the
    //    result and distance attenuates it; see the loop below.
    const radiusTiles = withinRadius(this.board, tile.x, tile.y, this.cfg.blastRadius)
    tile.state = 'detonated'
    events.push({
      kind: 'mineDetonated',
      coord: { x: tile.x, y: tile.y },
      intensity: tile.mineCharge,
      radius: radiusTiles.map(t => ({ x: t.x, y: t.y })),
    })

    // 3. Removing the mine decrements neighbours' live counts so numbers stay accurate.
    this.decrementAround(tile, events)

    // 4. Apply blast damage.
    for (const t of radiusTiles) {
      if (t.isMine) {
        // A mine caught in the blast reacts: a hidden one arms, an already-armed one gains
        // charge (the Chrono-Jump overlap). Keyed on being INSIDE the blast, so mines next to
        // each other reliably pump each other — it does not depend on the blast clearing ground.
        if (t.state === 'covered') this.armMine(t, 'blast', events)
        else if (t.state === 'armed') this.chargeMine(t, events)
        continue
      }
      if (t.state === 'cleared') continue
      // Per-tier blast bite: each class loses a set fraction of its MAX HP per point of charge
      // at the core (Common clears, Advanced ~80%, Elite ~50%, Fleet ~30%, Boss a sliver), so
      // the number of blasts to clear a tile is a property of its CLASS, not its (hidden) HP.
      // Charge multiplies it; distance attenuates it.
      const base = t.maxHp * this.cfg.blastPctByTier[t.tier]
      const dist = Math.max(Math.abs(t.x - tile.x), Math.abs(t.y - tile.y))
      const falloff = Math.pow(this.cfg.blastFalloff, Math.max(0, dist - 1))
      const dmg = Math.max(0, Math.round(base * tile.mineCharge * falloff))
      t.hp -= dmg
      if (t.hp <= 0) {
        // Vaporised by the blast: cleared, but its number is never revealed. Information
        // stays tied to risky manual taps.
        this.destroyGroundTile(t, events)
        chainCleared += 1
      } else {
        this.damageTile(t, events)
      }
    }

    if (chainCleared > this.maxChain) this.maxChain = chainCleared

    this.checkWin(events)
    return events
  }

  tick(deltaSeconds: number): EventList {
    if (this.status !== 'playing' || deltaSeconds <= 0) return []
    const events: GameEvent[] = []
    // Option 1: passive charge regen. Accumulate fractional charge, apply whole units.
    if (this.cfg.chargeRegenPerSecond > 0) {
      this.regenAccum += deltaSeconds * this.cfg.chargeRegenPerSecond
      const whole = Math.floor(this.regenAccum)
      if (whole > 0) {
        this.regenAccum -= whole
        this.setPlayerCharge(this.playerCharge + whole, events)
      }
    }
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
      moves: this.moves,
      status: this.status,
    }
  }

  result(): GameResult | null {
    return this.finalResult
  }

  // -- ground clicks -------------------------------------------------------

  private clickGround(tile: Tile, events: GameEvent[]): void {
    // Any tile can be worked by hand, but a single tap removes at most `handTapDamage` HP
    // (and never more charge than that). Commons clear in one tap; tough tiles take many, so
    // a blast is far better. One tile per tap — no flood-fill.
    const applied = Math.min(this.playerCharge, this.cfg.handTapDamage)
    if (applied >= tile.hp) {
      // Clean clear: pay the tile's full (hidden) HP.
      const cost = tile.hp
      this.setPlayerCharge(this.playerCharge - cost, events)
      this.clearGroundTile(tile, cost, events)
      this.checkWin(events)
      return
    }

    // Partial hand-chip: dent it by `applied` (0 if broke). The HP bar shows the progress.
    if (applied > 0) {
      tile.hp -= applied
      this.setPlayerCharge(this.playerCharge - applied, events)
    }
    this.damageTile(tile, events)
    this.checkWin(events)
  }

  /** A tappable tile (Common or Boss) took partial damage (charge spent < its HP, or a blast
   *  that didn't finish it): leave it damaged. The HP bar shows the progress. */
  private damageTile(tile: Tile, events: GameEvent[]): void {
    this.cracks++
    if (tile.state !== 'cracked') tile.state = 'cracked'
    const crack = Math.max(0, Math.min(1, 1 - tile.hp / tile.maxHp))
    events.push({ kind: 'tileCracked', coord: { x: tile.x, y: tile.y }, crack })
  }

  private clearGroundTile(tile: Tile, chargeSpent: number, events: GameEvent[]): void {
    tile.state = 'cleared'
    tile.numberKnown = true
    tile.hp = 0
    this.tilesCleared++
    events.push({ kind: 'tileCleared', coord: { x: tile.x, y: tile.y }, number: tile.adjacent, chargeSpent })
  }

  private destroyGroundTile(tile: Tile, events: GameEvent[]): void {
    tile.state = 'cleared'
    tile.numberKnown = false
    tile.hp = 0
    this.tilesCleared++
    events.push({ kind: 'tileDestroyed', coord: { x: tile.x, y: tile.y } })
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

  /** Decrement every ground neighbour's live count so revealed numbers stay accurate as
   *  the mine leaves the board. No flood-fill — a number reaching zero just shows zero. */
  private decrementAround(mine: Tile, events: GameEvent[]): void {
    for (const n of neighbours(this.board, mine.x, mine.y)) {
      if (n.isMine) continue
      if (n.adjacent <= 0) continue
      const from = n.adjacent
      n.adjacent--
      // Only a *known* number is visible, so only it can decrement on screen.
      if (n.state === 'cleared' && n.numberKnown) {
        events.push({ kind: 'numberDecremented', coord: { x: n.x, y: n.y }, from, to: n.adjacent })
      }
    }
  }

  /** A mine caught inside another mine's blast gains charge (capped) — the Chrono-Jump
   *  overlap. Called for every already-armed mine within the blast radius. */
  private chargeMine(mine: Tile, events: GameEvent[]): void {
    if (mine.mineCharge >= this.cfg.maxMineCharge) return // already at the cap
    const from = mine.mineCharge
    mine.mineCharge = Math.min(this.cfg.maxMineCharge, mine.mineCharge + this.cfg.chargeGainPerOverlap)
    events.push({ kind: 'mineChargeChanged', coord: { x: mine.x, y: mine.y }, from, to: mine.mineCharge })
  }

  // -- resources & end state ----------------------------------------------

  private setPlayerCharge(next: number, events: GameEvent[]): void {
    const from = this.playerCharge
    const clamped = Math.max(0, Math.min(this.cfg.maxPlayerCharge, next))
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
