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
import { DIFFICULTIES, blastRadiusForStack, medalForTime, type DifficultyConfig } from './tuning'
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

  private playerCharge: number
  private timeElapsed = 0
  private status: GameStatus = 'playing'

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
    this.board = generateBoard(this.cfg, opts.seed)
    this.playerCharge = this.cfg.startingCharge
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

    // 2. The mine leaves the board. Blast damage = the mine's stack (flat), and the radius
    //    also grows with the stack. Every non-boss tile is 1 HP so any blast vaporises it;
    //    the Boss takes `stack` damage. Bigger stack → more boss damage AND more reach.
    const stack = tile.mineCharge
    const radius = blastRadiusForStack(stack, this.cfg.blastRadiusCap)
    const radiusTiles = withinRadius(this.board, tile.x, tile.y, radius)
    tile.state = 'detonated'
    events.push({
      kind: 'mineDetonated',
      coord: { x: tile.x, y: tile.y },
      intensity: stack,
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
      // Flat `stack` damage to every tile in the square. 1-HP enemies vaporise; the Boss (the
      // only multi-hit tile) is chunked by `stack`.
      t.hp -= stack
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
    // The clock only counts up — it is the score, never a loss condition.
    this.timeElapsed += deltaSeconds
    return events
  }

  snapshot(): BoardSnapshot {
    return {
      width: this.board.width,
      height: this.board.height,
      tiles: this.board.tiles.map(t => this.view(t)),
      playerCharge: this.playerCharge,
      timeElapsed: this.timeElapsed,
      moves: this.moves,
      status: this.status,
      bossHp: this.bossHp(),
      bossMaxHp: this.cfg.bossHp,
    }
  }

  private bossHp(): number {
    const b = this.board.tiles.find(t => t.tier === 'boss')
    return b ? Math.max(0, b.hp) : 0
  }

  result(): GameResult | null {
    return this.finalResult
  }

  // -- ground clicks -------------------------------------------------------

  private clickGround(tile: Tile, events: GameEvent[]): void {
    // A hand-tap costs 1 charge and deals 1 damage. A 1-HP enemy clears; the Boss only chips
    // (the slow fallback — blasts are how you really kill it). Broke → the tap does nothing;
    // wait for regen or detonate a mine. One tile per tap, no flood-fill.
    if (this.playerCharge < 1) return
    this.setPlayerCharge(this.playerCharge - 1, events)
    tile.hp -= 1
    if (tile.hp <= 0) this.clearGroundTile(tile, 1, events)
    else this.damageTile(tile, events)
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
    if (mine.mineCharge >= this.cfg.stackCap) return // already at the cap
    const from = mine.mineCharge
    mine.mineCharge = Math.min(this.cfg.stackCap, mine.mineCharge + this.cfg.chargeGainPerOverlap)
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

  private checkWin(events: GameEvent[]): void {
    if (this.status !== 'playing') return
    for (const t of this.board.tiles) {
      if (t.state === 'covered' || t.state === 'cracked') return
    }
    this.endGame(events)
  }

  private endGame(events: GameEvent[]): void {
    this.status = 'won' // the only end state — the board is always completable
    const result = this.buildResult()
    this.finalResult = result
    events.push({ kind: 'gameWon', result })
  }

  private buildResult(): GameResult {
    const timeSeconds = Math.round(this.timeElapsed)
    const parLeft = Math.max(0, this.cfg.parSeconds - this.timeElapsed)
    return {
      seed: this.seed,
      difficulty: this.difficulty,
      outcome: 'won',
      // Score rewards speed: whatever of par you beat, scaled. Faster clear = higher score.
      score: Math.max(0, Math.round(parLeft * this.cfg.scoreDifficultyMultiplier)),
      timeSeconds,
      medal: medalForTime(this.cfg, timeSeconds),
      moves: this.moves,
      detonations: this.detonations,
      tilesCleared: this.tilesCleared,
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
