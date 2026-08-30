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

export class FxLayer {
  private readonly ctx: CanvasRenderingContext2D
  private particles: Particle[] = []
  private shocks: Shockwave[] = []
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

  /** A small cyan spark when charge transfers into an overlapping mine. */
  chargeSpark(x: number, y: number): void {
    if (this.opts.reduceMotion) return
    const { cx, cy } = this.cellCenter(x, y)
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * 40, vy: Math.sin(a) * 40 - 20,
        life: 1, maxLife: 0.4, color: '#35e0ff', size: 1.5,
      })
    }
    this.ensureRunning()
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
      if (this.particles.length || this.shocks.length || this.shakeAmp > 0.1) {
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
