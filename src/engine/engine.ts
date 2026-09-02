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
import { DIFFICULTIES, blastRadiusForStack, overlapBoost, medalForTime, type DifficultyConfig } from './tuning'
import {
  generateBoard,
  neighbours,
  tileAt,
  withinRadius,
  type Board,
  type Tile,
} from './board'
import { Rng } from './rng'

class Engine implements MinesweeperEngine {
  private readonly cfg: DifficultyConfig
  private readonly board: Board
  private readonly difficulty: Difficulty
  private readonly seed: string
  private readonly revealHooks: boolean
  private readonly targetSeconds: number | undefined
  private timedOut = false

  private playerCharge: number
  private timeElapsed = 0
  private hookCharges = 0
  private status: GameStatus = 'playing'

  private moves = 0
  private detonations = 0
  private cracks = 0
  private regenAccum = 0
  private maxChain = 0
  private tilesCleared = 0
  private finalResult: GameResult | null = null

  constructor(opts: EngineOptions) {
    this.cfg = DIFFICULTIES[opts.difficulty]
    this.difficulty = opts.difficulty
    this.seed = opts.seed
    this.revealHooks = opts.revealHooks ?? false
    this.targetSeconds = opts.targetSeconds
    this.board = generateBoard(this.cfg, opts.seed)
    this.playerCharge = this.cfg.startingCharge
  }

  /** Deep, independent copy for hypothetical play (see the interface). Shares the immutable config
   *  and per-tile identity is broken by copying every tile — the only deeply-mutated state — so
   *  applying moves to the copy never touches this instance. Bypasses board generation entirely. */
  clone(): MinesweeperEngine {
    const copy = Object.create(Engine.prototype) as Engine
    Object.assign(copy, this, {
      board: {
        width: this.board.width,
        height: this.board.height,
        opening: this.board.opening,
        mineCount: this.board.mineCount,
        tiles: this.board.tiles.map(t => ({ ...t })),
      },
    })
    return copy
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
      this.checkEnd(events)
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

    // 4a. Affect mines AND the Boss one ring BEYOND the blast, not just inside it. A mine or the
    //     Boss that merely NEIGHBOURS a blast tile is hit: a hidden mine arms, an armed mine gains
    //     charge, and the Boss (the only multi-hit tile) takes `stack` damage. This "touching the
    //     blast is enough" rule is what lets you play WITHOUT hooks — non-touching mines pump each
    //     other, and a mine with a single empty tile between it and the Boss still chips it. Hooks
    //     then become a way to build tighter, bigger chains for a better score, not a requirement.
    for (const t of withinRadius(this.board, tile.x, tile.y, radius + 1)) {
      if (t.isMine) {
        if (t.state === 'covered') this.armMine(t, 'blast', events)
        else if (t.state === 'armed') this.chargeMine(t, stack, events)
      } else if (t.tier === 'boss') {
        t.hp -= stack
        if (t.hp <= 0) this.destroyGroundTile(t, events)
        else this.damageTile(t, events)
      }
    }

    // 4b. Vaporise GROUND within the true blast radius (mines and the Boss are handled above at the
    //     extended +1 reach; the extra ring does NOT vaporise plain 1-HP ground).
    for (const t of radiusTiles) {
      if (t.isMine || t.tier === 'boss' || t.state === 'cleared') continue
      // Flat `stack` damage; every non-boss tile is 1 HP so any blast vaporises it.
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

    // 4c. Shrapnel. A blast doesn't just clear its radius — it also takes `floor(stack · shrapnelPerStack)`
    //     extra enemies with it, chosen from the live ground that merely TOUCHES the blast (the ring
    //     just outside the vaporised area). This is the field-clearing payoff for a big stack: growing
    //     a mine clears more per detonation even when the Boss is nowhere near, so ammo lasts longer.
    //     Picks are deterministic (seeded from this exact detonation) so a seed still reproduces a run,
    //     and they never touch mines or the Boss — shrapnel can't cheese the moated kill.
    const shrapnelKills = Math.floor(stack * this.cfg.shrapnelPerStack)
    if (shrapnelKills > 0) {
      const inner = new Set(radiusTiles.map(t => t.y * this.board.width + t.x))
      const ring: Tile[] = []
      for (const t of withinRadius(this.board, tile.x, tile.y, radius + 1)) {
        if (inner.has(t.y * this.board.width + t.x)) continue // already inside the blast
        if (t.isMine || t.tier === 'boss') continue // mines/Boss handled at 4a; shrapnel is ground only
        if (t.state !== 'covered' || t.hp <= 0) continue // only still-standing field enemies
        ring.push(t)
      }
      const rng = new Rng(`${this.seed}:shrapnel:${tile.x}:${tile.y}:${this.detonations}`)
      rng.shuffle(ring)
      const origin: Coord = { x: tile.x, y: tile.y }
      for (const t of ring.slice(0, shrapnelKills)) {
        this.destroyGroundTile(t, events, origin) // shrapnel: tagged with the blast origin for the tracer FX
        chainCleared += 1
      }
    }

    if (chainCleared > this.maxChain) this.maxChain = chainCleared

    this.checkEnd(events)
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
    this.timeElapsed += deltaSeconds
    // Speedrun countdown: if you can't clear before your best time, the run is lost ('too slow').
    if (this.targetSeconds !== undefined && this.timeElapsed >= this.targetSeconds) {
      this.timedOut = true
      this.endGame('lost', events)
    }
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
      hookCharges: this.hookCharges,
      stackCap: this.cfg.stackCap,
      blastRadiusCap: this.cfg.blastRadiusCap,
      gatherRadius: this.cfg.gatherRadius,
      overlapBoostPerStack: this.cfg.overlapBoostPerStack,
      minesRemaining: this.board.tiles.reduce((n, t) => n + (t.isMine && t.state !== 'detonated' ? 1 : 0), 0),
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
    // The Boss is immune to hand-taps — ONLY mine blasts hurt it. That's the whole game: build
    // stacks and deliver them. Tapping the Boss does nothing (no charge spent).
    if (tile.tier === 'boss') return
    // A hand-tap costs 1 charge and deals 1 damage, clearing a 1-HP enemy. Broke → the tap does
    // nothing; wait for regen or detonate a mine. One tile per tap, no flood-fill.
    if (this.playerCharge < 1) return
    this.setPlayerCharge(this.playerCharge - 1, events)
    tile.hp -= 1
    if (tile.hp <= 0) this.clearGroundTile(tile, 1, events)
    else this.damageTile(tile, events)
    this.checkEnd(events)
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
    this.collectHook(tile, events)
  }

  private destroyGroundTile(tile: Tile, events: GameEvent[], from?: Coord): void {
    tile.state = 'cleared'
    tile.numberKnown = false
    tile.hp = 0
    this.tilesCleared++
    events.push(from
      ? { kind: 'tileDestroyed', coord: { x: tile.x, y: tile.y }, from }
      : { kind: 'tileDestroyed', coord: { x: tile.x, y: tile.y } })
    this.collectHook(tile, events)
  }

  /** Clearing a Magnetic Hook tile (by tap or blast) grants one hook charge. */
  private collectHook(tile: Tile, events: GameEvent[]): void {
    if (!tile.isHook) return
    tile.isHook = false
    this.hookCharges += 1
    events.push({ kind: 'hookCharged', coord: { x: tile.x, y: tile.y }, to: this.hookCharges })
  }

  /** Spend a hook charge to move the armed mine at `coord` one tile in direction `dir` (any of
   *  the 8 directions; dir.x/dir.y taken as signs). It crushes a 1-HP enemy in the way; never
   *  onto another mine, the Boss, or off-grid. Adjacent numbers stay honest at both cells. */
  useHook(coord: Coord, dir: Coord): EventList {
    if (this.status !== 'playing' || this.hookCharges < 1) return []
    const mine = tileAt(this.board, coord.x, coord.y)
    if (!mine || !mine.isMine || mine.state !== 'armed') return []
    const dx = Math.sign(dir.x)
    const dy = Math.sign(dir.y)
    if (dx === 0 && dy === 0) return [] // no direction
    const dest = tileAt(this.board, mine.x + dx, mine.y + dy)
    // Valid target: on-grid, not the Boss, and not a LIVE mine. A detonated crater keeps isMine
    // set but is empty ground, so it's a fine landing spot; only armed/covered mines are blocked.
    if (!dest || dest.tier === 'boss' || (dest.isMine && dest.state !== 'detonated')) return []

    const events: GameEvent[] = []
    this.hookCharges -= 1
    this.moveMine(mine, dest, events)
    events.push({ kind: 'hookUsed', from: { x: coord.x, y: coord.y }, to: { x: dest.x, y: dest.y }, charges: this.hookCharges })
    this.checkEnd(events)
    return events
  }

  /** Relocate an armed mine to a cleared destination cell, transferring its armed state and
   *  stack, and re-deriving adjacency counts so revealed numbers stay truthful. */
  private moveMine(mine: Tile, dest: Tile, events: GameEvent[]): void {
    const stack = mine.mineCharge
    // Old cell becomes cleared ground (no number leak — it was covered), its neighbours lose 1.
    this.adjustNeighbourNumbers(mine, -1, events)
    mine.isMine = false
    mine.mineCharge = 0
    mine.state = 'cleared'
    mine.numberKnown = false
    mine.hp = 0
    // Recompute the vacated cell's own adjacency (it is ground now) — not shown (numberKnown
    // false), but kept correct for consistency.
    mine.adjacent = neighbours(this.board, mine.x, mine.y).filter(n => n.isMine).length
    // If an enemy still occupies the destination, the pull crushes it (a free clear).
    if (dest.state === 'covered' || dest.state === 'cracked') {
      dest.hp = 0
      this.tilesCleared++
      events.push({ kind: 'tileDestroyed', coord: { x: dest.x, y: dest.y } })
      this.collectHook(dest, events)
    }
    // New cell becomes the armed mine; its neighbours gain 1.
    dest.isMine = true
    dest.mineCharge = stack
    dest.state = 'armed'
    dest.numberKnown = false
    this.adjustNeighbourNumbers(dest, +1, events)
    events.push({ kind: 'mineArmed', coord: { x: dest.x, y: dest.y }, mineCharge: stack, via: 'blast' })
  }

  /** Add `delta` to every ground neighbour's live adjacent-mine count, emitting an event for
   *  the ones whose number is currently shown. Used when a mine appears/leaves a cell. */
  private adjustNeighbourNumbers(at: Tile, delta: number, events: GameEvent[]): void {
    for (const n of neighbours(this.board, at.x, at.y)) {
      if (n.isMine) continue
      const from = n.adjacent
      n.adjacent = Math.max(0, n.adjacent + delta)
      if (n.state === 'cleared' && n.numberKnown && n.adjacent !== from) {
        const kind = delta > 0 ? 'numberIncremented' : 'numberDecremented'
        events.push({ kind, coord: { x: n.x, y: n.y }, from, to: n.adjacent })
      }
    }
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

  /** A mine caught inside another mine's blast gains charge (capped) — the Chrono-Jump overlap. The
   *  boost scales with the DETONATOR's stack (`sourceStack`): a fat mine pumps its neighbour harder
   *  than a small one, so one big detonation snowballs the whole cluster. Called for every armed
   *  mine within the detonator's (extended) blast reach. */
  private chargeMine(mine: Tile, sourceStack: number, events: GameEvent[]): void {
    if (mine.mineCharge >= this.cfg.stackCap) return // already at the cap
    const from = mine.mineCharge
    const gain = overlapBoost(sourceStack, this.cfg.overlapBoostPerStack)
    mine.mineCharge = Math.min(this.cfg.stackCap, mine.mineCharge + gain)
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

  /** The most Boss damage the mines STILL on the board could ever deliver, if every one were
   *  perfectly gathered and chained (each fires at its escalated stack, capped). A conservative
   *  upper bound: if even this can't reach the Boss's HP, the run is unwinnable however well you play
   *  — you've spent too many mines clearing ground and have nothing left to finish the kill. */
  private bossStillKillable(): boolean {
    const hp = this.bossHp()
    if (hp <= 0) return true
    let mines = 0
    for (const t of this.board.tiles) if (t.isMine && t.state !== 'detonated') mines++
    const cap = this.cfg.stackCap
    const maxDeliverable = mines <= cap ? (mines * (mines + 1)) / 2 : (cap * (cap + 1)) / 2 + (mines - cap) * cap
    return maxDeliverable >= hp
  }

  private checkEnd(events: GameEvent[]): void {
    if (this.status !== 'playing') return
    // Loss first: the mine pool can no longer finish the Boss — bad allocation doomed the run.
    if (!this.bossStillKillable()) {
      this.endGame('lost', events)
      return
    }
    // Win: the whole field is cleared (the Boss, once dead, becomes cleared ground too).
    for (const t of this.board.tiles) {
      if (t.state === 'covered' || t.state === 'cracked') return
    }
    this.endGame('won', events)
  }

  private endGame(outcome: 'won' | 'lost', events: GameEvent[]): void {
    this.status = outcome
    const result = this.buildResult(outcome)
    this.finalResult = result
    events.push({ kind: outcome === 'won' ? 'gameWon' : 'gameLost', result })
  }

  private buildResult(outcome: 'won' | 'lost'): GameResult {
    const timeSeconds = Math.round(this.timeElapsed)
    const parLeft = Math.max(0, this.cfg.parSeconds - this.timeElapsed)
    return {
      seed: this.seed,
      difficulty: this.difficulty,
      outcome,
      timedOut: this.timedOut,
      // Score rewards speed on a win; a lost run scores nothing.
      score: outcome === 'won' ? Math.max(0, Math.round(parLeft * this.cfg.scoreDifficultyMultiplier)) : 0,
      timeSeconds,
      medal: outcome === 'won' ? medalForTime(this.cfg, timeSeconds) : 'none',
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
        // Hooks are hidden in normal play — a discovery, not a signpost. Only a dev/testing
        // build (revealHooks) exposes them so a debug view can mark them.
        return t.isHook && this.revealHooks ? { ...base, isHook: true } : base
    }
  }
}

export function createEngine(opts: EngineOptions): MinesweeperEngine {
  return new Engine(opts)
}
