/**
 * Canvas FX overlay. Everything here is deliberately NON-reactive: plain objects mutated
 * in a single rAF loop, drawing to a canvas that sits over the DOM board with
 * pointer-events:none. Particles never touch engine state or the DOM tree.
 *
 * Honours prefers-reduced-motion: when set, one-shot flourishes are suppressed and the
 * screen never shakes.
 */

export interface FxOptions {
  reduceMotion: boolean
  /** Reads the current CSS pixel size of a board cell + gap, so FX line up with tiles. */
  cellMetrics: () => { size: number; gap: number; originX: number; originY: number }
  /** Sets the board container shake offset (px). */
  setShake: (x: number, y: number) => void
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  color: string
  size: number
}

interface Shockwave {
  x: number
  y: number
  radius: number
  maxRadius: number
  life: number
}

/** A shrapnel streak: a bright bolt that flies from the blast to an enemy just outside the
 *  radius and bursts on arrival. Distinct amber, so it reads as "the blast reached past its
 *  edge" rather than as part of the cyan detonation. */
interface Tracer {
  x0: number
  y0: number
  x1: number
  y1: number
  t: number // 0..1 flight progress
  speed: number // progress per second
  burst: boolean
}

export class FxLayer {
  private readonly ctx: CanvasRenderingContext2D
  private particles: Particle[] = []
  private shocks: Shockwave[] = []
  private tracers: Tracer[] = []
  private shakeAmp = 0
  private raf = 0
  private running = false
  private lastT = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: FxOptions,
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private cellCenter(x: number, y: number): { cx: number; cy: number } {
    const { size, gap, originX, originY } = this.opts.cellMetrics()
    return {
      cx: originX + x * (size + gap) + size / 2,
      cy: originY + y * (size + gap) + size / 2,
    }
  }

  /** A mine going off: shockwave ring, debris burst, and a screen kick scaled by damage. */
  detonation(x: number, y: number, intensity: number): void {
    if (this.opts.reduceMotion) return
    const { cx, cy } = this.cellCenter(x, y)
    const { size } = this.opts.cellMetrics()
    // `intensity` is the mine's charge (1..maxMineCharge): a chip pops small, a charged mine roars.
    const damage = 3 + intensity * 1.6
    this.shocks.push({ x: cx, y: cy, radius: size * 0.3, maxRadius: size * (2 + damage * 0.4), life: 1 })
    const n = Math.min(48, 14 + damage * 4)
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.4
      const speed = 60 + Math.random() * 140 * (1 + damage * 0.15)
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 1,
        maxLife: 0.5 + Math.random() * 0.5,
        color: Math.random() < 0.5 ? '#35e0ff' : '#eaffff',
        size: 1.5 + Math.random() * 2.5,
      })
    }
    this.shakeAmp = Math.min(9, 3 + damage * 0.8)
    this.ensureRunning()
  }

  /** Charge transferring into an overlapping mine. `magnitude` is the boost size (to − from): a +1
   *  is a small cyan spark, but a scaled boost from a fat detonator (+2, +3) erupts brighter, faster,
   *  and with a little ring — so a super-charge visibly reads bigger than an ordinary overlap. */
  chargeSpark(x: number, y: number, magnitude = 1): void {
    if (this.opts.reduceMotion) return
    const { cx, cy } = this.cellCenter(x, y)
    const big = magnitude >= 2
    const n = big ? 8 + magnitude * 6 : 6
    const speed = big ? 60 + magnitude * 25 : 40
    const color = big ? '#c6f9ff' : '#35e0ff' // brighter white-cyan for a super-charge
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 20,
        life: 1, maxLife: big ? 0.5 : 0.4, color, size: big ? 2.4 : 1.5,
      })
    }
    if (big) {
      const { size } = this.opts.cellMetrics()
      this.shocks.push({ x: cx, y: cy, radius: size * 0.2, maxRadius: size * (0.7 + magnitude * 0.25), life: 1 })
    }
    this.ensureRunning()
  }

  /** Shrapnel: a bright amber bolt flies from the blast (`fx`,`fy`) to an enemy just outside its
   *  radius (`tx`,`ty`) and bursts on arrival — the visible "the blast reached past its edge". */
  shrapnel(fx: number, fy: number, tx: number, ty: number): void {
    if (this.opts.reduceMotion) return
    const from = this.cellCenter(fx, fy)
    const to = this.cellCenter(tx, ty)
    this.tracers.push({ x0: from.cx, y0: from.cy, x1: to.cx, y1: to.cy, t: 0, speed: 5.5, burst: false })
    this.ensureRunning()
  }

  /** The little amber puff where a shrapnel bolt lands. */
  private shrapnelImpact(cx: number, cy: number): void {
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 50 + Math.random() * 90
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 1, maxLife: 0.35 + Math.random() * 0.3,
        color: Math.random() < 0.5 ? '#ffab3d' : '#ffe3a6', size: 1.4 + Math.random() * 1.8,
      })
    }
  }

  private ensureRunning(): void {
    if (this.running) return
    this.running = true
    this.lastT = performance.now()
    const step = (t: number) => {
      const dt = Math.min(0.05, (t - this.lastT) / 1000)
      this.lastT = t
      this.update(dt)
      this.draw()
      if (this.particles.length || this.shocks.length || this.tracers.length || this.shakeAmp > 0.1) {
        this.raf = requestAnimationFrame(step)
      } else {
        this.running = false
        this.opts.setShake(0, 0)
        this.clear()
      }
    }
    this.raf = requestAnimationFrame(step)
  }

  private update(dt: number): void {
    for (const p of this.particles) {
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += 120 * dt // gravity
      p.life -= dt / p.maxLife
    }
    this.particles = this.particles.filter(p => p.life > 0)

    for (const s of this.shocks) {
      s.radius += (s.maxRadius - s.radius) * Math.min(1, dt * 8)
      s.life -= dt * 1.6
    }
    this.shocks = this.shocks.filter(s => s.life > 0)

    for (const tr of this.tracers) {
      tr.t += tr.speed * dt
      if (tr.t >= 1 && !tr.burst) {
        tr.burst = true
        this.shrapnelImpact(tr.x1, tr.y1)
      }
    }
    this.tracers = this.tracers.filter(tr => tr.t < 1)

    if (this.shakeAmp > 0.1) {
      this.shakeAmp *= Math.pow(0.001, dt) // fast decay
      this.opts.setShake((Math.random() * 2 - 1) * this.shakeAmp, (Math.random() * 2 - 1) * this.shakeAmp)
    } else {
      this.shakeAmp = 0
    }
  }

  private draw(): void {
    const ctx = this.ctx
    this.clear()
    for (const s of this.shocks) {
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(53, 224, 255, ${Math.max(0, s.life) * 0.6})`
      ctx.lineWidth = 2.5 * Math.max(0.2, s.life)
      ctx.stroke()
    }
    for (const tr of this.tracers) {
      const t = Math.min(1, tr.t)
      const hx = tr.x0 + (tr.x1 - tr.x0) * t
      const hy = tr.y0 + (tr.y1 - tr.y0) * t
      const tailT = Math.max(0, t - 0.28) // a short bright streak trailing the head
      const bx = tr.x0 + (tr.x1 - tr.x0) * tailT
      const by = tr.y0 + (tr.y1 - tr.y0) * tailT
      const grad = ctx.createLinearGradient(bx, by, hx, hy)
      grad.addColorStop(0, 'rgba(255, 171, 61, 0)')
      grad.addColorStop(1, 'rgba(255, 227, 166, 0.95)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 2.4
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(bx, by)
      ctx.lineTo(hx, hy)
      ctx.stroke()
    }
    ctx.lineCap = 'butt'
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life)
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  private clear(): void {
    const { width, height } = this.canvas
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, width / dpr, height / dpr)
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.running = false
  }
}
