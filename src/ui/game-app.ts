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
import { autoPlay } from '../engine/auto-player'
import type { BoardSnapshot, Coord, Difficulty, EventList, GameResult, MinesweeperEngine, Tier, TileView } from '../engine/types'
import { FxLayer } from './fx-layer'

// Real Tower enemy sprites (from @tmrxjd/tower-assets), grouped into the game's tiers.
import mineUrl from './assets/mine.webp'
import enemyBasic from './assets/enemy-basic.webp'
import enemyFast from './assets/enemy-fast.webp'
import enemyTank from './assets/enemy-tank.webp'
import enemyRanged from './assets/enemy-ranged.webp'
import enemyProtector from './assets/enemy-protector.webp'
import enemyVampire from './assets/enemy-vampire.webp'
import enemyRay from './assets/enemy-ray.webp'
import enemyScatter from './assets/enemy-scatter.webp'
import enemySaboteur from './assets/enemy-saboteur.webp'
import enemyCommander from './assets/enemy-commander.webp'
import enemyOvercharge from './assets/enemy-overcharge.webp'
import enemyBoss from './assets/enemy-boss.webp'

/** Each tier maps to the real enemy category's members; a tile picks one deterministically. */
const ENEMY_SETS: Record<Tier, readonly string[]> = {
  common: [enemyBasic, enemyFast, enemyTank],
  advanced: [enemyRanged, enemyProtector],
  elite: [enemyVampire, enemyRay, enemyScatter],
  fleet: [enemySaboteur, enemyCommander, enemyOvercharge],
  boss: [enemyBoss],
}

const TIER_MIN_COST: Record<Tier, number> = { common: 1, advanced: 2, elite: 4, fleet: 6, boss: 18 }
const TIER_LABEL: Record<Tier, string> = {
  common: 'Common', advanced: 'Advanced', elite: 'Elite', fleet: 'Fleet', boss: 'Boss',
}

/** Stable per-tile sprite pick from a tier's set (deterministic in board coords). */
function spriteFor(tier: Tier, x: number, y: number): string {
  const set = ENEMY_SETS[tier]
  const h = (x * 73856093) ^ (y * 19349663)
  return set[Math.abs(h) % set.length]!
}

/** Charge → orb ring colour. Ramps cool→hot so a rising mine is unmistakable. */
function chargeColor(charge: number): string {
  const stops = ['#35e0ff', '#46c56a', '#ffd23f', '#ff9f45', '#ff5b6e']
  return stops[Math.min(stops.length - 1, Math.max(0, charge - 1))]!
}

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
  private elCoach!: HTMLElement
  private helpDialog!: HTMLElement

  private width = 0
  private height = 0
  private maxChargeSeen = 1
  private confirmCoord: Coord | null = null
  private focusIndex = 0

  private rafId = 0
  private lastFrame = 0
  private paused = false

  private demo = false
  private demoTimers: ReturnType<typeof setTimeout>[] = []
  private cursor!: HTMLElement
  private hintsOn = false

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
    this.cursor = root.querySelector('.ilm-cursor')!
    this.elCharge = root.querySelector('[data-charge]')!
    this.elChargeFill = root.querySelector('.ilm-chargebar__fill')!
    this.elTime = root.querySelector('[data-time]')!
    this.elTimeStat = root.querySelector('.ilm-stat--time')!
    this.elCoach = root.querySelector('[data-coach]')!
    this.helpDialog = root.querySelector('[data-help-dialog]')!

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
    const label: Record<Difficulty, string> = { gentle: 'Easy', standard: 'Standard', hard: 'Hard' }
    const opts = (Object.keys(DIFFICULTIES) as Difficulty[])
      .map(d => `<option value="${d}">${label[d]}</option>`)
      .join('')
    return `
      <header class="ilm-header">
        <div class="ilm-title">
          <span class="ilm-title__mark" aria-hidden="true"></span>
          <span class="ilm-title__text">Inner Land Minesweeper</span>
        </div>
        <button class="ilm-iconbtn" data-help aria-label="How to play" title="How to play">?</button>
      </header>

      <div class="ilm-hud">
        <div class="ilm-stats">
          <div class="ilm-stat ilm-stat--charge">
            <span class="ilm-stat__label">Charge</span>
            <span class="ilm-stat__value" data-charge>0</span>
            <div class="ilm-chargebar"><div class="ilm-chargebar__fill"></div></div>
          </div>
          <div class="ilm-stat ilm-stat--time">
            <span class="ilm-stat__label">Time</span>
            <span class="ilm-stat__value" data-time>0:00</span>
          </div>
        </div>
        <div class="ilm-controls">
          <select class="ilm-select" data-difficulty aria-label="Difficulty">${opts}</select>
          <button class="ilm-btn" data-hints aria-pressed="false">Hints</button>
          <button class="ilm-btn" data-demo>Watch demo</button>
          <button class="ilm-btn" data-new>New board</button>
        </div>
      </div>

      <div class="ilm-coach" data-coach aria-live="polite"></div>

      <div class="ilm-stage">
        <div class="ilm-board" role="grid" aria-label="Minesweeper board"></div>
        <canvas class="ilm-fx"></canvas>
        <div class="ilm-cursor" aria-hidden="true"></div>
        <div class="ilm-paused">Paused</div>
        <div class="ilm-banner">
          <div class="ilm-banner__card">
            <div class="ilm-banner__title"></div>
            <div class="ilm-banner__detail"></div>
            <button class="ilm-btn ilm-btn--primary" data-again>Play again</button>
          </div>
        </div>
      </div>

      ${this.helpMarkup()}
    `
  }

  private helpMarkup(): string {
    return `
      <div class="ilm-help" data-help-dialog hidden role="dialog" aria-modal="true" aria-label="How to play">
        <div class="ilm-help__card">
          <button class="ilm-iconbtn ilm-help__close" data-help-close aria-label="Close">×</button>
          <h2 class="ilm-help__title">How to play</h2>
          <p class="ilm-help__lead">You're a mine <em>sweeper</em>. Finding a mine is good — mines are
            your weapons. Clear every ground tile before time runs out.</p>

          <div class="ilm-help__row">
            <span class="ilm-help__icon ilm-help__icon--ground">3</span>
            <div><b>Sweep ground.</b> Click a covered tile. If it's ground it clears and shows a
              number — how many mines touch it, exactly like classic Minesweeper. Sweeping costs
              <b>charge</b>.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon"><img src="${mineUrl}" alt="" class="ilm-help__sprite"></span>
            <div><b>Find a mine → it arms.</b> A mine you click doesn't kill you — it uncovers as a
              glowing <b>Inner Land Mine</b>. <b>Click it to detonate:</b> it blasts a hole in the
              board and refills your charge. Its ring brightens and shifts colour as its charge grows.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__swatches" aria-hidden="true">
              <i style="background:var(--enemy-common)"></i><i style="background:var(--enemy-advanced)"></i><i style="background:var(--enemy-elite)"></i><i style="background:var(--enemy-fleet)"></i>
            </span>
            <div><b>Enemies show toughness by colour.</b>
              <b style="color:var(--enemy-common)">Common (grey)</b> →
              <b style="color:var(--enemy-advanced)">Advanced (yellow)</b> →
              <b style="color:var(--enemy-elite)">Elite (blue)</b> →
              <b style="color:var(--enemy-fleet)">Fleet (red)</b> is how much charge a tile costs to
              clear; the exact cost is hidden inside the class — that's the risk. Damaged enemies show
              a health bar.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon"><img src="${enemyBoss}" alt="" class="ilm-help__sprite"></span>
            <div><b>The Boss</b> sits at the centre — far tougher than anything else. You'll chip it
              down or blast it repeatedly to finish the board.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon ilm-help__icon--crack"></span>
            <div><b>Can't afford it?</b> The tile cracks instead of clearing, drains your charge, and
              costs time. Detonate a mine to recharge rather than grinding.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon ilm-help__icon--flag">✓</span>
            <div><b>Win</b> by clearing every ground tile. <b>Lose</b> only if the timer runs out —
              take your time and deduce.</div>
          </div>

          <p class="ilm-help__keys">Keyboard: arrow keys move · Enter / Space acts on the focused
            tile. Toggle <b>Hints</b> for a live nudge on what to do next.</p>
          <button class="ilm-btn ilm-btn--primary ilm-help__got" data-help-close>Got it</button>
        </div>
      </div>
    `
  }

  private wireControls(): void {
    const sel = this.root.querySelector<HTMLSelectElement>('[data-difficulty]')!
    sel.value = this.difficulty
    sel.addEventListener('change', () => { this.stopDemo(); this.newGame(sel.value as Difficulty, randomSeed()) })
    this.root.querySelector('[data-new]')!.addEventListener('click', () => { this.stopDemo(); this.newGame(this.difficulty, randomSeed()) })
    this.root.querySelector('[data-again]')!.addEventListener('click', () => { this.stopDemo(); this.newGame(this.difficulty, randomSeed()) })
    this.root.querySelector('[data-demo]')!.addEventListener('click', () => this.toggleDemo())
    this.root.querySelector('[data-hints]')!.addEventListener('click', () => this.toggleHints())
    this.root.querySelector('[data-help]')!.addEventListener('click', () => this.openHelp())
    this.root.querySelectorAll('[data-help-close]').forEach(el => {
      el.addEventListener('click', () => this.closeHelp())
    })
    this.helpDialog.addEventListener('click', e => {
      if (e.target === this.helpDialog) this.closeHelp() // backdrop click
    })
    this.board.addEventListener('keydown', e => this.onKey(e as KeyboardEvent))
    document.addEventListener('keydown', this.onGlobalKey)
  }

  private toggleHints(): void {
    this.hintsOn = !this.hintsOn
    this.root.classList.toggle('hints-on', this.hintsOn)
    const btn = this.root.querySelector<HTMLButtonElement>('[data-hints]')!
    btn.classList.toggle('is-active', this.hintsOn)
    btn.setAttribute('aria-pressed', String(this.hintsOn))
    this.updateCoach(this.engine.snapshot())
  }

  private openHelp(): void {
    this.helpDialog.hidden = false
    this.root.querySelector<HTMLElement>('[data-help-close]')?.focus()
  }
  private closeHelp(): void {
    this.helpDialog.hidden = true
    this.root.querySelector<HTMLElement>('[data-help]')?.focus()
  }
  private readonly onGlobalKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.helpDialog.hidden) this.closeHelp()
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
    // Floor of 18px keeps a dense board (15 cols) inside a ~375px phone; pinch-zoom covers
    // precision. Ceiling of 44px stops tiles ballooning on wide screens.
    const size = Math.max(18, Math.min(44, Math.floor(raw)))
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
      btn.addEventListener('click', () => this.onTileClick(t.coord))
      this.board.appendChild(btn)
      return btn
    })
  }

  // -- input -------------------------------------------------------------

  private onTileClick(coord: Coord): void {
    if (this.demo) this.stopDemo() // a real interaction takes control from the demo
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
    const unaffordable =
      TIER_MIN_COST[tile.tier] > snap.playerCharge &&
      (tile.tier === 'elite' || tile.tier === 'fleet' || tile.tier === 'boss')
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
          // Flash every tile the blast touched so the affected area is unmistakable.
          this.pulseTile(e.coord, 'blast-origin')
          for (const c of e.radius) this.pulseTile(c, 'blast-hit')
          break
        case 'mineChargeChanged':
          // A mine's charge went up: spark it and flash it in its new charge colour.
          this.fx.chargeSpark(e.coord.x, e.coord.y)
          this.flashChargeUp(e.coord, e.to)
          break
        case 'gameWon':
        case 'gameLost':
          this.onEnd(e.result)
          break
      }
    }
    this.render(this.engine.snapshot())
  }

  /** Add a one-shot animation class to a tile, self-removing so it can re-trigger. */
  private pulseTile(coord: Coord, cls: string): void {
    const el = this.tiles[this.indexOf(coord)]
    if (!el) return
    el.classList.remove(cls)
    void el.offsetWidth // reflow so re-adding restarts the animation
    el.classList.add(cls)
    globalThis.setTimeout(() => el.classList.remove(cls), 520)
  }

  private flashChargeUp(coord: Coord, charge: number): void {
    const el = this.tiles[this.indexOf(coord)]
    if (!el) return
    el.style.setProperty('--charge-color', chargeColor(charge))
    this.pulseTile(coord, 'charge-up')
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
    this.updateCoach(snap)
  }

  /** A live one-line hint reflecting what the player should do next — the main "what is
   *  happening / what do I do" indicator. */
  private updateCoach(snap: BoardSnapshot): void {
    if (snap.status !== 'playing') {
      this.elCoach.textContent = ''
      return
    }
    const armed = snap.tiles.some(t => t.state === 'armed')
    const cleared = snap.tiles.some(t => t.state === 'cleared')
    const covered = snap.tiles.filter(t => t.state === 'covered' || t.state === 'cracked')
    const cheapestMin = covered.reduce((m, t) => Math.min(m, TIER_MIN_COST[t.tier]), Infinity)

    let msg: string
    if (!cleared && !armed) {
      msg = 'Click any tile to sweep it — ground reveals a number, a mine arms as a glowing orb.'
    } else if (armed && snap.playerCharge < cheapestMin) {
      msg = 'Low charge — click a glowing orb to detonate it and recharge.'
    } else if (armed) {
      msg = 'A glowing orb is an armed mine — click it to detonate a blast and gain charge.'
    } else {
      msg = 'Sweep ground to reveal numbers (adjacent mines). Numbers guide you to the mines.'
    }
    this.elCoach.textContent = msg
  }

  private renderTile(el: HTMLButtonElement, t: TileView): void {
    el.dataset.tier = t.tier
    el.className = 'ilm-tile'
    el.classList.add(`is-${t.state === 'detonated' ? 'destroyed' : t.state}`)

    const cls = TIER_LABEL[t.tier]
    let label = `${cls} enemy`
    if (t.state === 'cleared') {
      if (t.number === undefined) {
        el.classList.add('is-destroyed')
        el.innerHTML = ''
        label = 'cleared crater'
      } else {
        el.dataset.n = String(t.number)
        el.innerHTML = `<span class="ilm-num">${t.number === 0 ? '' : t.number}</span>`
        label = t.number === 0 ? 'cleared, no adjacent mines' : `cleared, ${t.number} adjacent`
      }
    } else if (t.state === 'armed') {
      // The Inner Land Mine sprite with a charge ring whose colour ramps with charge.
      const charge = t.mineCharge ?? 1
      el.style.setProperty('--charge', String(Math.min(1, charge / 6)))
      el.style.setProperty('--charge-color', chargeColor(charge))
      el.innerHTML =
        `<span class="ilm-orb"><img class="ilm-mine-img" src="${mineUrl}" alt="" draggable="false">` +
        `<span class="ilm-orb__mult">${charge}×</span></span>`
      label = `armed Inner Land Mine, charge ${charge} times`
    } else {
      // covered or cracked — the enemy sprite is a mask filled with the class colour.
      const sprite = `<span class="ilm-enemy" style="--sprite:url(${spriteFor(t.tier, t.coord.x, t.coord.y)})"></span>`
      if (t.state === 'cracked' && t.crack !== undefined) {
        el.style.setProperty('--crack', String(t.crack))
        const hp = Math.max(0, 1 - t.crack)
        el.innerHTML = `${sprite}<span class="ilm-hp" style="--hp:${hp}"></span>`
        label = `${cls} enemy, ${Math.round(hp * 100)}% health`
      } else {
        el.innerHTML = sprite
        label = `${cls} enemy`
      }
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

  // -- watch demo --------------------------------------------------------

  private toggleDemo(): void {
    if (this.demo) this.stopDemo()
    else this.startDemo()
  }

  private startDemo(): void {
    this.demo = true
    this.root.classList.add('is-demo')
    this.root.querySelector('[data-demo]')!.textContent = 'Stop demo'
    if (this.engine.snapshot().status !== 'playing') this.newGame(this.difficulty, randomSeed())
    this.demoStep()
  }

  private stopDemo(): void {
    if (!this.demo) return
    this.demo = false
    this.root.classList.remove('is-demo')
    this.cursor.classList.remove('is-click')
    this.root.querySelector('[data-demo]')!.textContent = 'Watch demo'
    for (const id of this.demoTimers) clearTimeout(id)
    this.demoTimers = []
  }

  /** One watchable move: glide the ghost cursor to the target, "click", apply, repeat. */
  private demoStep(): void {
    if (!this.demo) return
    const snap = this.engine.snapshot()
    if (snap.status !== 'playing') {
      // Finished a board — pause on the result, then start a fresh one and keep going.
      this.demoTimers.push(
        globalThis.setTimeout(() => {
          if (!this.demo) return
          this.newGame(this.difficulty, randomSeed())
          this.demoStep()
        }, 2400),
      )
      return
    }
    const action = autoPlay(snap)
    if (!action) {
      this.demoTimers.push(globalThis.setTimeout(() => this.demoStep(), 400))
      return
    }
    this.moveCursorTo(action.coord)
    this.demoTimers.push(
      globalThis.setTimeout(() => {
        if (!this.demo) return
        this.cursor.classList.add('is-click')
        this.performAction(action)
        this.demoTimers.push(
          globalThis.setTimeout(() => {
            this.cursor.classList.remove('is-click')
            this.demoStep()
          }, 260),
        )
      }, 430),
    )
  }

  private performAction(action: { type: 'reveal' | 'detonate'; coord: Coord }): void {
    if (action.type === 'detonate') this.apply(this.engine.detonate(action.coord))
    else this.apply(this.engine.reveal(action.coord))
  }

  private moveCursorTo(coord: Coord): void {
    const el = this.tiles[this.indexOf(coord)]
    if (!el) return
    const stage = this.stage.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    this.cursor.style.left = `${r.left - stage.left + r.width / 2}px`
    this.cursor.style.top = `${r.top - stage.top + r.height / 2}px`
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
    this.stopDemo()
    this.stopLoop()
    this.fx.destroy()
    document.removeEventListener('visibilitychange', this.onVisibility)
    document.removeEventListener('keydown', this.onGlobalKey)
    globalThis.removeEventListener?.('resize', this.onResize)
  }
}
