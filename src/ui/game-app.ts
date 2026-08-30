/**
 * The view/controller layer. Framework-free: it builds DOM once, then reconciles each tile
 * from engine snapshots (correctness) while feeding the engine's event list to the canvas
 * FX layer (flourish). The engine is the single source of truth; this file never decides
 * game rules.
 *
 * Input: click a covered tile to reveal it; click a glowing orb (an armed mine) to detonate
 * it. Arming and detonating stay two distinct actions on two distinct visual states, so
 * "detonate is separate" holds without a mode toggle. Keyboard mirrors this with a roving
 * tabindex + Enter/Space. A catastrophic click (tough ground you visibly can't afford) asks
 * for a confirm.
 */

import { createEngine } from '../engine/engine'
import { DIFFICULTIES } from '../engine/tuning'
import { randomSeed } from '../engine/rng'
import type { BoardSnapshot, Coord, Difficulty, EventList, GameResult, MinesweeperEngine, Tier, TileView } from '../engine/types'
import { FxLayer } from './fx-layer'

const TIER_MIN_COST: Record<Tier, number> = { light: 1, medium: 2, heavy: 4, elite: 6 }
const PIP_COUNT: Record<Tier, number> = { light: 1, medium: 2, heavy: 3, elite: 4 }

export interface GameAppOptions {
  difficulty?: Difficulty
  seed?: string
  /** Called at end of game with the result — the host's handoff (persistence/leaderboard). */
  onResult?: (result: GameResult) => void
}

export class GameApp {
  private engine!: MinesweeperEngine
  private difficulty: Difficulty
  private seed: string
  private readonly reduceMotion: boolean

  private readonly root: HTMLElement
  private readonly board: HTMLElement
  private readonly stage: HTMLElement
  private readonly fxCanvas: HTMLCanvasElement
  private readonly banner: HTMLElement
  private readonly pausedEl: HTMLElement
  private fx!: FxLayer
  private tiles: HTMLButtonElement[] = []

  private elCharge!: HTMLElement
  private elChargeFill!: HTMLElement
  private elTime!: HTMLElement
  private elTimeStat!: HTMLElement
  private elSeed!: HTMLElement

  private width = 0
  private height = 0
  private maxChargeSeen = 1
  private confirmCoord: Coord | null = null
  private focusIndex = 0

  private rafId = 0
  private lastFrame = 0
  private paused = false

  private readonly onResult: ((r: GameResult) => void) | undefined

  constructor(root: HTMLElement, opts: GameAppOptions = {}) {
    this.root = root
    this.difficulty = opts.difficulty ?? 'gentle'
    this.seed = opts.seed ?? randomSeed()
    this.onResult = opts.onResult
    this.reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    root.classList.add('ilm-root')
    if (this.reduceMotion) root.classList.add('reduce-motion')
    root.innerHTML = this.chrome()

    this.stage = root.querySelector('.ilm-stage')!
    this.board = root.querySelector('.ilm-board')!
    this.fxCanvas = root.querySelector('.ilm-fx')!
    this.banner = root.querySelector('.ilm-banner')!
    this.pausedEl = root.querySelector('.ilm-paused')!
    this.elCharge = root.querySelector('[data-charge]')!
    this.elChargeFill = root.querySelector('.ilm-chargebar__fill')!
    this.elTime = root.querySelector('[data-time]')!
    this.elTimeStat = root.querySelector('.ilm-stat--time')!
    this.elSeed = root.querySelector('[data-seed]')!

    this.wireControls()
    this.fx = new FxLayer(this.fxCanvas, {
      reduceMotion: this.reduceMotion,
      cellMetrics: () => this.cellMetrics(),
      setShake: (x, y) => {
        this.stage.style.setProperty('--shake-x', `${x}px`)
        this.stage.style.setProperty('--shake-y', `${y}px`)
      },
    })

    document.addEventListener('visibilitychange', this.onVisibility)
    globalThis.addEventListener?.('resize', this.onResize)
    this.newGame(this.difficulty, this.seed)
  }

  // -- markup ------------------------------------------------------------

  private chrome(): string {
    const opts = (Object.keys(DIFFICULTIES) as Difficulty[])
      .map(d => `<option value="${d}">${d[0]!.toUpperCase() + d.slice(1)}</option>`)
      .join('')
    return `
      <div class="ilm-hud">
        <div class="ilm-stat ilm-stat--charge">
          <span class="ilm-stat__label">Charge</span>
          <span class="ilm-stat__value" data-charge>0</span>
          <div class="ilm-chargebar"><div class="ilm-chargebar__fill"></div></div>
        </div>
        <div class="ilm-stat ilm-stat--time">
          <span class="ilm-stat__label">Time</span>
          <span class="ilm-stat__value" data-time>0:00</span>
        </div>
        <div class="ilm-spacer"></div>
        <label class="ilm-stat" style="min-width:auto">
          <span class="ilm-stat__label">Difficulty</span>
          <select class="ilm-select" data-difficulty>${opts}</select>
        </label>
        <button class="ilm-btn" data-new>New board</button>
      </div>
      <div class="ilm-stage">
        <div class="ilm-board" role="grid" aria-label="Minesweeper board"></div>
        <canvas class="ilm-fx"></canvas>
        <div class="ilm-paused">Paused</div>
        <div class="ilm-banner">
          <div class="ilm-banner__card">
            <div class="ilm-banner__title"></div>
            <div class="ilm-banner__detail"></div>
            <button class="ilm-btn" data-again>Play again</button>
          </div>
        </div>
      </div>
      <div class="ilm-hud" style="font-size:11px;color:var(--ink-dim)">
        <span>Seed <code data-seed></code></span>
        <div class="ilm-spacer"></div>
        <span>Click ground to sweep · click a glowing orb to detonate</span>
      </div>
    `
  }

  private wireControls(): void {
    const sel = this.root.querySelector<HTMLSelectElement>('[data-difficulty]')!
    sel.value = this.difficulty
    sel.addEventListener('change', () => this.newGame(sel.value as Difficulty, randomSeed()))
    this.root.querySelector('[data-new]')!.addEventListener('click', () => this.newGame(this.difficulty, randomSeed()))
    this.root.querySelector('[data-again]')!.addEventListener('click', () => this.newGame(this.difficulty, randomSeed()))
    this.board.addEventListener('keydown', e => this.onKey(e as KeyboardEvent))
  }

  // -- lifecycle ---------------------------------------------------------

  newGame(difficulty: Difficulty, seed: string): void {
    this.difficulty = difficulty
    this.seed = seed
    this.engine = createEngine({ difficulty, seed, now: () => performance.now() / 1000 })
    const snap = this.engine.snapshot()
    this.width = snap.width
    this.height = snap.height
    this.maxChargeSeen = Math.max(1, snap.playerCharge)
    this.confirmCoord = null
    this.focusIndex = 0
    this.buildGrid(snap)
    this.fitBoard()
    this.banner.classList.remove('is-shown', 'win', 'lose')
    this.elSeed.textContent = seed
    this.render(snap)
    requestAnimationFrame(() => this.syncCanvasSize())
    this.startLoop()
  }

  /** Size tiles so the board fits the viewport width, clamped to a comfortable touch
   *  target. Pinch-zoom covers the smallest cases (dense boards on tiny screens). */
  private fitBoard(): void {
    const gap = 3
    // Measure the mount parent (a real block constrained by the viewport), NOT the root —
    // the root's own width is capped below, so measuring it would ratchet down on resize.
    const cs = getComputedStyle(this.root)
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    const outer = this.root.parentElement?.clientWidth || document.documentElement.clientWidth || 620
    const avail = outer - padX
    if (avail <= 0) return // not laid out yet
    const raw = (avail - (this.width - 1) * gap) / this.width
    const size = Math.max(24, Math.min(44, Math.floor(raw)))
    this.root.style.setProperty('--tile-size', `${size}px`)
    // Hug the board: cap the card to the board's natural width so it doesn't leave dead
    // space on wide screens, while still shrinking to the viewport on narrow ones.
    const boardW = this.width * size + (this.width - 1) * gap
    this.root.style.maxWidth = `${boardW + padX}px`
  }

  private readonly onResize = (): void => {
    this.fitBoard()
    this.syncCanvasSize()
  }

  private buildGrid(snap: BoardSnapshot): void {
    this.board.style.setProperty('--cols', String(snap.width))
    this.board.innerHTML = ''
    this.tiles = snap.tiles.map((t, i) => {
      const btn = document.createElement('button')
      btn.className = 'ilm-tile'
      btn.dataset.i = String(i)
      btn.setAttribute('role', 'gridcell')
      btn.tabIndex = i === 0 ? 0 : -1
      const pips = document.createElement('span')
      pips.className = 'ilm-pips'
      btn.appendChild(pips)
      btn.addEventListener('click', () => this.onTileClick(t.coord))
      this.board.appendChild(btn)
      return btn
    })
  }

  // -- input -------------------------------------------------------------

  private onTileClick(coord: Coord): void {
    if (this.engine.snapshot().status !== 'playing' || this.paused) return
    const tile = this.tileView(coord)
    if (!tile) return

    if (tile.state === 'armed') {
      this.confirmCoord = null
      this.apply(this.engine.detonate(coord))
      return
    }
    if (tile.state !== 'covered' && tile.state !== 'cracked') return

    // Catastrophic-click confirm: tough ground the player visibly cannot afford.
    const snap = this.engine.snapshot()
    const unaffordable = TIER_MIN_COST[tile.tier] > snap.playerCharge && (tile.tier === 'heavy' || tile.tier === 'elite')
    if (unaffordable && !this.sameCoord(this.confirmCoord, coord)) {
      this.setConfirm(coord)
      return
    }
    this.confirmCoord = null
    this.clearConfirmClass()
    this.apply(this.engine.reveal(coord))
  }

  private onKey(e: KeyboardEvent): void {
    const cols = this.width
    let next = this.focusIndex
    switch (e.key) {
      case 'ArrowRight': next = Math.min(this.tiles.length - 1, this.focusIndex + 1); break
      case 'ArrowLeft': next = Math.max(0, this.focusIndex - 1); break
      case 'ArrowDown': next = Math.min(this.tiles.length - 1, this.focusIndex + cols); break
      case 'ArrowUp': next = Math.max(0, this.focusIndex - cols); break
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const t = this.tiles[this.focusIndex]
        if (t) this.onTileClick(this.coordOf(this.focusIndex))
        return
      }
      default: return
    }
    e.preventDefault()
    this.moveFocus(next)
  }

  private moveFocus(i: number): void {
    this.tiles[this.focusIndex]?.setAttribute('tabindex', '-1')
    this.focusIndex = i
    const el = this.tiles[i]
    if (el) {
      el.setAttribute('tabindex', '0')
      el.focus()
    }
  }

  private setConfirm(coord: Coord): void {
    this.clearConfirmClass()
    this.confirmCoord = coord
    const el = this.tiles[this.indexOf(coord)]
    el?.classList.add('confirm-armed')
    el?.setAttribute('aria-label', `${this.tileView(coord)?.tier} tile — low charge, activate again to chip`)
  }

  private clearConfirmClass(): void {
    for (const t of this.tiles) t.classList.remove('confirm-armed')
  }

  // -- apply events + render --------------------------------------------

  private apply(events: EventList): void {
    for (const e of events) {
      switch (e.kind) {
        case 'mineDetonated':
          this.fx.detonation(e.coord.x, e.coord.y, e.damage)
          break
        case 'mineChargeChanged':
          this.fx.chargeSpark(e.coord.x, e.coord.y)
          break
        case 'gameWon':
        case 'gameLost':
          this.onEnd(e.result)
          break
      }
    }
    this.render(this.engine.snapshot())
  }

  private render(snap: BoardSnapshot): void {
    this.maxChargeSeen = Math.max(this.maxChargeSeen, snap.playerCharge)
    for (let i = 0; i < snap.tiles.length; i++) {
      this.renderTile(this.tiles[i]!, snap.tiles[i]!)
    }
    this.elCharge.textContent = String(snap.playerCharge)
    const pct = Math.max(0, Math.min(100, (snap.playerCharge / this.maxChargeSeen) * 100))
    this.elChargeFill.style.setProperty('--charge-pct', `${pct}%`)
    this.elTime.textContent = this.fmtTime(snap.timeRemaining)
    this.elTimeStat.classList.toggle('is-low', snap.timeRemaining <= 30)
  }

  private renderTile(el: HTMLButtonElement, t: TileView): void {
    el.dataset.tier = t.tier
    el.className = 'ilm-tile'
    el.classList.add(`is-${t.state === 'detonated' ? 'destroyed' : t.state}`)

    let label = `${t.tier} tile`
    if (t.state === 'cleared') {
      if (t.number === undefined) {
        el.classList.add('is-destroyed')
        el.textContent = ''
        label = 'cleared crater'
      } else {
        el.dataset.n = String(t.number)
        el.textContent = t.number === 0 ? '' : String(t.number)
        label = t.number === 0 ? 'cleared, no adjacent mines' : `cleared, ${t.number} adjacent`
      }
    } else if (t.state === 'armed') {
      el.innerHTML = `<span class="ilm-orb" style="--charge:${Math.min(1, (t.mineCharge ?? 1) / 6)}"><span class="ilm-orb__mult">${t.mineCharge ?? 1}×</span></span>`
      label = `armed mine, charge ${t.mineCharge ?? 1} times`
    } else {
      // covered or cracked — restore pips, set crack severity
      if (t.crack !== undefined) el.style.setProperty('--crack', String(t.crack))
      el.innerHTML = `<span class="ilm-pips">${'<span class="ilm-pip"></span>'.repeat(PIP_COUNT[t.tier])}</span>`
      label = t.state === 'cracked' ? `${t.tier} tile, cracked` : `${t.tier} tile, covered`
    }
    el.setAttribute('aria-label', label)
    // Preserve roving tabindex.
    el.tabIndex = Number(el.dataset.i) === this.focusIndex ? 0 : -1
  }

  private onEnd(result: GameResult): void {
    this.stopLoop()
    const win = result.outcome === 'won'
    this.banner.classList.add('is-shown', win ? 'win' : 'lose')
    this.banner.querySelector('.ilm-banner__title')!.textContent = win ? 'Swept' : "Time's up"
    this.banner.querySelector('.ilm-banner__detail')!.textContent = win
      ? `Score ${result.score} · ${result.timeRemaining}s left · best chain ${result.maxChain} · ${result.cracks} cracks`
      : `Cleared ${Math.round(result.boardClearedFraction * 100)}% · ${result.cracks} cracks`
    this.onResult?.(result)
  }

  // -- timer loop + pause ------------------------------------------------

  private startLoop(): void {
    this.stopLoop()
    this.lastFrame = performance.now()
    const step = (t: number) => {
      const dt = (t - this.lastFrame) / 1000
      this.lastFrame = t
      if (!this.paused && this.engine.snapshot().status === 'playing') {
        const ev = this.engine.tick(dt)
        if (ev.length) this.apply(ev)
        else this.render(this.engine.snapshot())
      }
      if (this.engine.snapshot().status === 'playing') this.rafId = requestAnimationFrame(step)
    }
    this.rafId = requestAnimationFrame(step)
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private readonly onVisibility = (): void => {
    this.paused = document.hidden
    this.pausedEl.classList.toggle('is-shown', this.paused && this.engine.snapshot().status === 'playing')
    if (!this.paused) this.lastFrame = performance.now() // don't credit hidden time to the timer
  }

  // -- geometry / helpers ------------------------------------------------

  private syncCanvasSize(): void {
    const rect = this.stage.getBoundingClientRect()
    this.fx.resize(rect.width, rect.height)
  }

  private cellMetrics(): { size: number; gap: number; originX: number; originY: number } {
    const a = this.tiles[0]?.getBoundingClientRect()
    const stage = this.stage.getBoundingClientRect()
    if (!a) return { size: 40, gap: 3, originX: 0, originY: 0 }
    const b = this.tiles[1]?.getBoundingClientRect()
    const gap = b && b.left > a.left ? b.left - a.right : 3
    return { size: a.width, gap, originX: a.left - stage.left, originY: a.top - stage.top }
  }

  private tileView(coord: Coord): TileView | undefined {
    return this.engine.snapshot().tiles[this.indexOf(coord)]
  }
  private indexOf(coord: Coord): number {
    return coord.y * this.width + coord.x
  }
  private coordOf(i: number): Coord {
    return { x: i % this.width, y: Math.floor(i / this.width) }
  }
  private sameCoord(a: Coord | null, b: Coord | null): boolean {
    return !!a && !!b && a.x === b.x && a.y === b.y
  }
  private fmtTime(s: number): string {
    const sec = Math.max(0, Math.ceil(s))
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
  }

  destroy(): void {
    this.stopLoop()
    this.fx.destroy()
    document.removeEventListener('visibilitychange', this.onVisibility)
    globalThis.removeEventListener?.('resize', this.onResize)
  }
}
