/**
 * The view/controller layer. Framework-free: it builds DOM once, then reconciles each tile
 * from engine snapshots (correctness) while feeding the engine's event list to the canvas
 * FX layer (flourish). The engine is the single source of truth; this file never decides
 * game rules.
 *
 * Input: tap a Common to clear it or a hidden mine to arm it; click a glowing armed mine to
 * detonate it. Tapping a tough tile chips it slowly; a blast clears it fast.
 * Keyboard mirrors taps with a roving tabindex + Enter/Space.
 */

import { createEngine } from '../engine/engine'
import { DIFFICULTIES } from '../engine/tuning'
import { randomSeed } from '../engine/rng'
import { chooseAction } from '../engine/mcts'
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

/** DEV/testing flag: append `?showhooks` to the URL to mark Magnetic Hook tiles on the board.
 *  Off by default — in normal play hooks are a hidden discovery, not a signposted objective. */
const REVEAL_HOOKS =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('showhooks')

/** Each tier maps to the real enemy category's members; a tile picks one deterministically. */
const ENEMY_SETS: Record<Tier, readonly string[]> = {
  common: [enemyBasic, enemyFast, enemyTank],
  advanced: [enemyRanged, enemyProtector],
  elite: [enemyVampire, enemyRay, enemyScatter],
  fleet: [enemySaboteur, enemyCommander, enemyOvercharge],
  boss: [enemyBoss],
}

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
  private elHookCount!: HTMLElement
  private elMines!: HTMLElement
  /** The time to beat this run (your best on this difficulty), or undefined for a free baseline run. */
  private target: number | undefined
  private elBossBar!: HTMLElement
  private elBossFill!: HTMLElement
  private elBossHp!: HTMLElement
  private elCoach!: HTMLElement
  /** Pending long-press timer id for touch-triggered hook pulls. */
  private hookHold: ReturnType<typeof setTimeout> | null = null
  /** Set when a long-press/drag already acted, so the trailing synthetic click is ignored. */
  private suppressNextClick = false
  /** The armed mine a pointer went down on — dragging it to a neighbour hooks it that way. */
  private dragStart: { coord: Coord; armed: boolean } | null = null
  private helpDialog!: HTMLElement

  private width = 0
  private height = 0
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
    this.elHookCount = root.querySelector('[data-hookcount]')!
    this.elMines = root.querySelector('[data-mines]')!
    this.elBossBar = root.querySelector('[data-bossbar]')!
    this.elBossFill = root.querySelector('[data-bossfill]')!
    this.elBossHp = root.querySelector('[data-bosshp]')!
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
          <span class="ilm-title__mark" style="--sprite:url(${mineUrl})" aria-hidden="true"></span>
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
          <div class="ilm-stat ilm-stat--hook">
            <span class="ilm-stat__label">Mag Hooks</span>
            <span class="ilm-stat__value" data-hookcount>0</span>
          </div>
          <div class="ilm-stat ilm-stat--mines">
            <span class="ilm-stat__label">Mines</span>
            <span class="ilm-stat__value" data-mines>0</span>
          </div>
        </div>
        <div class="ilm-bossbar" data-bossbar hidden>
          <span class="ilm-bossbar__label">Boss</span>
          <div class="ilm-bossbar__track"><div class="ilm-bossbar__fill" data-bossfill></div></div>
          <span class="ilm-bossbar__hp" data-bosshp></span>
        </div>
        <div class="ilm-controls">
          <select class="ilm-select" data-difficulty aria-label="Difficulty">${opts}</select>
          <button class="ilm-btn" data-hints aria-pressed="false">Hints</button>
          <button class="ilm-btn" data-demo>Autoplay</button>
          <button class="ilm-btn" data-new>Restart</button>
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
          <p class="ilm-help__lead">Your mines are <b>one scarce pool</b> that has to do two jobs: clear
            the field <em>and</em> kill the <em>Boss</em>. Spend too many opening the board and the Boss
            outlives your ammo — the run is lost. It's a <b>speedrun</b>: after your first clear, the clock
            counts <b>down</b> from your best time, so every game has to be faster than the last.</p>

          <div class="ilm-help__row">
            <span class="ilm-help__icon ilm-help__icon--ground">3</span>
            <div><b>Tap to clear.</b> Every field tile is a 1-HP enemy — one tap clears it and reveals
              a number: how many mines touch it, like classic Minesweeper. Tapping spends <b>charge</b>,
              and you <b>start with only a little</b> — you earn more by <b>detonating mines</b>, and a
              <b>bigger mine refunds more</b>. So you can't just hand-clear the board; tap to find mines
              and open lanes, then let <b>blasts</b> do the bulk clearing. Colours are just enemy variety.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon"><span class="ilm-help__sprite" style="--sprite:url(${mineUrl})"></span></span>
            <div><b>Mines are your ammo — grow them.</b> Tap a hidden mine to <b>arm</b> it (safe); tap an
              armed mine to <b>detonate</b> — a square blast clears its area for free, <b>arms the mines it
              touches</b> (so blasts chain), and takes a few <b>extra enemies just outside it</b> with it.
              A mine's <b>stack</b> (the <code>N×</code> badge) drives everything: damage, blast size, how
              many extra enemies it shreds, and how much charge it refunds. And a detonation <b>pumps
              nearby armed mines — the bigger the mine you set off, the bigger the boost</b> (a 4× lifts a
              1× to 3×), so one fat mine snowballs the whole cluster. The HUD <b>Mines</b> counter is your
              ammo for <em>both</em> jobs — budget it.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon" style="color:var(--energy)">⌇</span>
            <div><b>Magnetic Hook — you'll need it.</b> The Boss sits in a ring no blast can reach, so you
              <b>can't</b> just detonate near it. Clear a hidden <b style="color:var(--energy)">Magnetic
              Hook</b> tile to gain a <b>Mag Hook</b> charge, then <b>drag</b> an armed mine one tile
              (crushing whatever's there) or <b>right-click</b> / <b>long-press</b> to pull it toward the
              Boss. Gather a cluster of charged mines against the Boss, then set them off.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon"><img src="${enemyBoss}" alt="" class="ilm-help__sprite"></span>
            <div><b>The Boss</b> sits at the centre — the only multi-hit enemy, and <b>only mine blasts
              hurt it</b> (taps do nothing). Hook charged mines in beside it and detonate; a bigger stack
              hits harder. Its HP bar shows at the top of the board.</div>
          </div>
          <div class="ilm-help__row">
            <span class="ilm-help__icon ilm-help__icon--flag">✓</span>
            <div><b>Win</b> by clearing the field and killing the Boss — fast. You <b>lose</b> if you run
              your mines dry with the Boss still alive, or if the <b>countdown to your best time</b> hits
              zero. Your first game on a difficulty is untimed and sets the bar; beat it and the new time
              becomes the one to chase. Clear times still earn <b style="color:#ffd23f">gold</b> /
              silver / bronze.</div>
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
    this.root.querySelector('[data-new]')!.addEventListener('click', () => { this.stopDemo(); this.newGame(this.difficulty, randomSeed()) }) // Restart → a fresh board
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
    // Complete a drag-to-hook: released on a neighbour of the armed mine we grabbed → pull it there.
    this.board.addEventListener('pointerup', e => {
      const start = this.dragStart
      this.dragStart = null
      if (!start || !start.armed) return
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.ilm-tile')
      if (!el?.dataset.i) return
      const end = this.coordOf(Number(el.dataset.i))
      const dx = end.x - start.coord.x
      const dy = end.y - start.coord.y
      if ((dx || dy) && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
        this.suppressNextClick = true // the drag acted; don't also detonate on the click
        this.hookMine(start.coord, { x: dx, y: dy })
      }
    })
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

  /** Your best clear time on a difficulty (whole seconds), from local storage, or undefined. */
  private bestTime(difficulty: Difficulty): number | undefined {
    try {
      const v = globalThis.localStorage?.getItem(`ilm.best.${difficulty}`)
      const n = v == null ? NaN : Number(v)
      return Number.isFinite(n) && n > 0 ? n : undefined
    } catch {
      return undefined
    }
  }

  private saveBestTime(difficulty: Difficulty, seconds: number): void {
    try {
      globalThis.localStorage?.setItem(`ilm.best.${difficulty}`, String(Math.round(seconds)))
    } catch {
      /* private mode / no storage — a session-only best is fine */
    }
  }

  newGame(difficulty: Difficulty, seed: string): void {
    this.difficulty = difficulty
    this.seed = seed
    // Speedrun: the clock counts DOWN from your best time on this difficulty. Your first game has no
    // best, so it runs free (untimed) and sets the baseline; every game after must beat it.
    this.target = this.bestTime(difficulty)
    this.engine = createEngine({
      difficulty,
      seed,
      now: () => performance.now() / 1000,
      revealHooks: REVEAL_HOOKS,
      ...(this.target !== undefined ? { targetSeconds: this.target } : {}),
    })
    const snap = this.engine.snapshot()
    this.width = snap.width
    this.height = snap.height
    this.focusIndex = 0
    this.buildGrid(snap)
    this.fitBoard()
    this.banner.classList.remove('is-shown', 'win', 'lose')
    this.render(snap)
    requestAnimationFrame(() => this.syncCanvasSize())
    this.startLoop()
  }

  /** Size tiles so the whole board fits BOTH the viewport width and its remaining height,
   *  clamped to a comfortable touch target. A square board sized to width alone overflows
   *  vertically on the big (15×15) grid, so we take whichever dimension binds. Pinch-zoom
   *  covers the smallest cases (dense boards on tiny screens). */
  private fitBoard(): void {
    const gap = 3
    // Measure the mount parent (a real block constrained by the viewport), NOT the root —
    // the root's own width is capped below, so measuring it would ratchet down on resize.
    const cs = getComputedStyle(this.root)
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    const outer = this.root.parentElement?.clientWidth || document.documentElement.clientWidth || 620
    const availW = outer - padX
    if (availW <= 0) return // not laid out yet
    const rawW = (availW - (this.width - 1) * gap) / this.width

    // Height budget: from the board's top edge down to the bottom of the viewport, less a
    // little breathing room. The board's top doesn't depend on tile size (the header/HUD
    // above it have fixed heights), so this measurement is stable and won't feed back.
    let raw = rawW
    const viewportH = document.documentElement.clientHeight
    const boardTop = this.board.getBoundingClientRect().top
    const availH = viewportH - boardTop - (parseFloat(cs.paddingBottom) + 12)
    if (availH > 0) {
      const rawH = (availH - (this.height - 1) * gap) / this.height
      raw = Math.min(rawW, rawH)
    }

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
      // Drag an armed mine to a neighbour = directional hook. Record where a drag begins.
      btn.addEventListener('pointerdown', () => {
        const v = this.tileView(t.coord)
        this.dragStart = { coord: t.coord, armed: v?.state === 'armed' }
      })
      // Right-click quick-pulls a hook toward the Boss (drag for a chosen direction — see below).
      btn.addEventListener('contextmenu', e => {
        e.preventDefault()
        this.hookMine(t.coord, this.towardBoss(t.coord))
      })
      // Long-press quick-pulls toward the Boss (touch). Cancel on move/release/scroll.
      btn.addEventListener('touchstart', () => {
        this.clearHookHold()
        this.hookHold = setTimeout(() => {
          this.hookHold = null
          this.suppressNextClick = true // the long-press already acted; don't also detonate
          this.hookMine(t.coord, this.towardBoss(t.coord))
        }, 450)
      }, { passive: true })
      const cancel = (): void => this.clearHookHold()
      btn.addEventListener('touchend', cancel)
      btn.addEventListener('touchmove', cancel)
      btn.addEventListener('touchcancel', cancel)
      this.board.appendChild(btn)
      return btn
    })
  }

  // -- input -------------------------------------------------------------

  private clearHookHold(): void {
    if (this.hookHold !== null) {
      clearTimeout(this.hookHold)
      this.hookHold = null
    }
  }

  private onTileClick(coord: Coord): void {
    if (this.suppressNextClick) { this.suppressNextClick = false; return } // a long-press already acted
    if (this.demo) this.stopDemo() // a real interaction takes control from the demo
    if (this.engine.snapshot().status !== 'playing' || this.paused) return
    const tile = this.tileView(coord)
    if (!tile) return

    if (tile.state === 'armed') {
      this.apply(this.engine.detonate(coord))
      return
    }
    if (tile.state !== 'covered' && tile.state !== 'cracked') return
    // Tapping a tough tile chips it slowly (engine caps hand-tap damage); a blast is faster.

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


  // -- apply events + render --------------------------------------------

  private apply(events: EventList): void {
    for (const e of events) {
      switch (e.kind) {
        case 'mineDetonated':
          this.fx.detonation(e.coord.x, e.coord.y, e.intensity)
          // Flash every tile the blast touched so the affected area is unmistakable.
          this.pulseTile(e.coord, 'blast-origin')
          for (const c of e.radius) this.pulseTile(c, 'blast-hit')
          break
        case 'mineChargeChanged':
          // A mine's charge went up: spark it (scaled by the boost size, so a fat detonator's
          // super-charge erupts bigger than an ordinary +1) and flash it in its new charge colour.
          this.fx.chargeSpark(e.coord.x, e.coord.y, e.to - e.from)
          this.flashChargeUp(e.coord, e.to)
          break
        case 'tileDestroyed':
          // Shrapnel kills carry their blast origin — fly an amber bolt out to the struck enemy.
          if (e.from) {
            this.fx.shrapnel(e.from.x, e.from.y, e.coord.x, e.coord.y)
            this.pulseTile(e.coord, 'shrapnel-hit')
          }
          break
        case 'gameWon':
          this.onEnd(e.result, true)
          break
        case 'gameLost':
          this.onEnd(e.result, false)
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

  /** Spend a hook charge to pull the armed mine at `coord` one tile in `dir`. A no-op with no
   *  charge, on a non-armed tile, or a blocked target. Drag an armed mine to choose the direction;
   *  a right-click / long-press with no direction defaults toward the Boss. */
  private hookMine(coord: Coord, dir: Coord): void {
    if (this.demo) this.stopDemo()
    if (this.engine.snapshot().status !== 'playing' || this.paused) return
    if (this.engine.snapshot().hookCharges < 1) return
    const tile = this.tileView(coord)
    if (!tile || tile.state !== 'armed') return
    this.apply(this.engine.useHook(coord, dir))
  }

  /** A one-step direction from `coord` toward the board centre (the Boss). */
  private towardBoss(coord: Coord): Coord {
    const bx = (this.width - 1) >> 1
    const by = (this.height - 1) >> 1
    return { x: Math.sign(bx - coord.x), y: Math.sign(by - coord.y) }
  }

  private render(snap: BoardSnapshot): void {
    for (let i = 0; i < snap.tiles.length; i++) {
      this.renderTile(this.tiles[i]!, snap.tiles[i]!)
    }
    const maxCharge = DIFFICULTIES[this.difficulty].maxPlayerCharge
    this.elCharge.textContent = `${snap.playerCharge}/${maxCharge}`
    const pct = Math.max(0, Math.min(100, (snap.playerCharge / maxCharge) * 100))
    this.elChargeFill.style.setProperty('--charge-pct', `${pct}%`)
    // With a best to beat, the clock counts DOWN from it (turns red near zero); the baseline run
    // counts up.
    if (this.target !== undefined) {
      const remaining = Math.max(0, this.target - snap.timeElapsed)
      this.elTime.textContent = this.fmtTime(remaining)
      this.elTimeStat.classList.toggle('is-low', remaining <= 5)
    } else {
      this.elTime.textContent = this.fmtTime(snap.timeElapsed)
    }
    this.elHookCount.textContent = String(snap.hookCharges)
    this.elMines.textContent = String(snap.minesRemaining)
    // Boss bar: show once the boss has taken a hit (it's covered/full at first).
    const bossPct = snap.bossMaxHp > 0 ? (snap.bossHp / snap.bossMaxHp) * 100 : 0
    this.elBossBar.hidden = snap.bossHp >= snap.bossMaxHp
    this.elBossFill.style.setProperty('--boss-pct', `${bossPct}%`)
    this.elBossHp.textContent = `${snap.bossHp}/${snap.bossMaxHp}`
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
    const bossHurt = snap.bossHp < snap.bossMaxHp

    let msg: string
    if (!cleared && !armed) {
      msg = 'Tap tiles to clear the field and find mines — a mine arms as a glowing orb.'
    } else if (snap.hookCharges > 0 && armed) {
      msg = `You hold ${snap.hookCharges} Magnetic Hook — right-click (or long-press) an armed mine to pull it toward the Boss.`
    } else if (bossHurt && armed) {
      msg = 'Deliver charged mine blasts to the centre — only blasts hurt the Boss.'
    } else if (armed) {
      msg = 'Detonate mines to clear ground and pump nearby mines’ stacks. Grow big stacks toward the centre.'
    } else {
      msg = 'Tap to open lanes and uncover mines; blasts clear far faster than tapping.'
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
        `<span class="ilm-orb"><span class="ilm-mine-glyph" style="--sprite:url(${mineUrl})"></span>` +
        `<span class="ilm-orb__mult">${charge}×</span></span>`
      label = `armed Inner Land Mine, charge ${charge} times`
    } else if (t.state === 'detonated') {
      // A detonated mine leaves an empty crater — NOT a fresh enemy.
      el.innerHTML = ''
      label = 'detonated crater'
    } else {
      // covered or cracked — the enemy sprite is a mask filled with the class colour. Ordinary
      // enemies are 1 HP (no bar); only the multi-hit Boss shows a tile HP bar.
      const sprite = `<span class="ilm-enemy" style="--sprite:url(${spriteFor(t.tier, t.coord.x, t.coord.y)})"></span>`
      const crack = t.crack ?? 0
      if (t.state === 'cracked') el.style.setProperty('--crack', String(crack))
      const hpBar = t.tier === 'boss' ? `<span class="ilm-hp" style="--hp:${Math.max(0, 1 - crack)}"></span>` : ''
      // A Magnetic Hook bonus sits on top of the enemy — a visible objective to route to.
      const hook = t.isHook ? '<span class="ilm-hookmark" aria-hidden="true">⌇</span>' : ''
      if (t.isHook) el.classList.add('is-hook')
      el.innerHTML = `${sprite}${hpBar}${hook}`
      label = t.isHook ? `${cls} enemy with a Magnetic Hook` : `${cls} enemy`
    }
    el.setAttribute('aria-label', label)
    // Preserve roving tabindex.
    el.tabIndex = Number(el.dataset.i) === this.focusIndex ? 0 : -1
  }

  private onEnd(result: GameResult, won: boolean): void {
    this.stopLoop()
    const title = this.banner.querySelector('.ilm-banner__title')!
    const detail = this.banner.querySelector('.ilm-banner__detail')!
    if (won) {
      // A win that beats your best (or the first one) sets the new bar every later run counts down to.
      const prevBest = this.bestTime(this.difficulty)
      const isBest = prevBest === undefined || result.timeSeconds < prevBest
      if (isBest) this.saveBestTime(this.difficulty, result.timeSeconds)
      this.banner.classList.add('is-shown', 'win')
      const medal = result.medal === 'none' ? '' : `${result.medal.toUpperCase()} · `
      title.textContent = isBest ? 'New best!' : 'Cleared'
      detail.textContent = isBest
        ? `${medal}${this.fmtTime(result.timeSeconds)}${prevBest !== undefined ? ` (beat ${this.fmtTime(prevBest)})` : ''} — the time to beat now`
        : `${medal}${this.fmtTime(result.timeSeconds)} · best ${this.fmtTime(prevBest!)} · didn't beat it`
    } else {
      this.banner.classList.add('is-shown', 'lose')
      if (result.timedOut) {
        title.textContent = 'Too slow'
        detail.textContent = `Ran out of time to beat your best (${this.fmtTime(this.target ?? result.timeSeconds)}). Restart and go faster.`
      } else {
        title.textContent = 'Out of mines'
        detail.textContent = `The Boss survives — too many mines spent clearing. ${result.detonations} blasts · ${result.moves} moves`
      }
    }
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
    this.demoStuck = 0
    this.root.classList.add('is-demo')
    this.root.querySelector('[data-demo]')!.textContent = 'Stop'
    if (this.engine.snapshot().status !== 'playing') this.newGame(this.difficulty, randomSeed())
    this.demoStep()
  }

  private stopDemo(): void {
    if (!this.demo) return
    this.demo = false
    this.root.classList.remove('is-demo')
    this.cursor.classList.remove('is-click')
    this.root.querySelector('[data-demo]')!.textContent = 'Autoplay'
    for (const id of this.demoTimers) clearTimeout(id)
    this.demoTimers = []
  }

  /** A signature of "progress" — if it doesn't change after a move, the demo made no
   *  headway (e.g. only shielded tiles and no mines left). */
  private progressSig(snap: BoardSnapshot): string {
    let covered = 0
    let armed = 0
    for (const t of snap.tiles) {
      if (t.state === 'covered' || t.state === 'cracked') covered++
      else if (t.state === 'armed') armed++
    }
    // Boss HP + hook charges count too, so chipping the Boss or hooking a mine reads as progress.
    return `${covered}|${armed}|${snap.playerCharge}|${snap.bossHp}|${snap.hookCharges}`
  }

  private demoStuck = 0

  private demoRestart(delay: number): void {
    this.demoStuck = 0
    this.demoTimers.push(
      globalThis.setTimeout(() => {
        if (!this.demo) return
        this.newGame(this.difficulty, randomSeed())
        this.demoStep()
      }, delay),
    )
  }

  /** One watchable move: glide the ghost cursor to the target, "click", apply, repeat. */
  private demoStep(): void {
    if (!this.demo) return
    const snap = this.engine.snapshot()
    if (snap.status !== 'playing') return this.demoRestart(2400) // won/lost — next board
    // The demo is driven by the MCTS planner, not the heuristic — it searches from the live position
    // each move. A wall-clock budget keeps the thinking snappy (hidden under the cursor glide) so the
    // board stays responsive; the choice still emerges from simulated futures, so it plays variedly.
    const action = chooseAction(this.engine, { timeBudgetMs: 90 })
    if (!action) return this.demoRestart(1200) // no move — next board

    const sigBefore = this.progressSig(snap)
    this.moveCursorTo(action.coord)
    this.demoTimers.push(
      globalThis.setTimeout(() => {
        if (!this.demo) return
        this.cursor.classList.add('is-click')
        this.performAction(action)
        // If a move made no progress a few times running, this board is stuck — move on.
        this.demoStuck = this.progressSig(this.engine.snapshot()) === sigBefore ? this.demoStuck + 1 : 0
        this.demoTimers.push(
          globalThis.setTimeout(() => {
            this.cursor.classList.remove('is-click')
            if (this.demoStuck >= 5) return this.demoRestart(1000)
            this.demoStep()
          }, 260),
        )
      }, 430),
    )
  }

  private performAction(action: { type: 'reveal' | 'detonate' | 'hook'; coord: Coord; dir?: Coord }): void {
    if (action.type === 'detonate') this.apply(this.engine.detonate(action.coord))
    else if (action.type === 'hook') this.apply(this.engine.useHook(action.coord, action.dir ?? { x: 0, y: 0 }))
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
  }  private fmtTime(s: number): string {
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
