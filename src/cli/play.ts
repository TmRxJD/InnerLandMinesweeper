/**
 * Inner Land Minesweeper — CLI.
 *
 * A text interface to the pure engine: render the board as ASCII, drive it with tap/detonate
 * commands, or let the reference bot auto-play. Built for driving, testing, and tuning the
 * game headlessly (the browser is not needed).
 *
 *   pnpm play                       # interactive REPL (easy, random seed)
 *   pnpm play -- --diff hard --seed s1
 *   pnpm play -- --debug            # reveal mine locations (marked ✱)
 *   pnpm play -- --moves "t4,4 d2,1 t5,5"   # scripted, prints final board
 *   pnpm play -- --auto             # the reference bot plays it; prints the result
 *   pnpm play -- --auto --n 200 --diff hard # bot win-rate over many seeds (quick tune loop)
 *
 * Commands (REPL or --moves): t x,y = tap · d x,y = detonate · n = new board · p = print · q = quit
 */

import { createEngine } from '../engine/engine'
import { generateBoard } from '../engine/board'
import { DIFFICULTIES } from '../engine/tuning'
import { randomSeed } from '../engine/rng'
import { autoPlay } from '../engine/auto-player'
import type { BoardSnapshot, Difficulty, MinesweeperEngine, TileView } from '../engine/types'

const TIER_CHAR: Record<string, string> = { common: 'c', advanced: 'a', elite: 'e', fleet: 'f', boss: 'B' }

interface Args {
  diff: Difficulty
  seed: string
  debug: boolean
  moves: string | null
  auto: boolean
  n: number
  spm: number
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  const has = (flag: string): boolean => argv.includes(flag)
  const d = get('--diff')
  return {
    diff: d === 'standard' || d === 'hard' ? d : 'gentle',
    seed: get('--seed') ?? randomSeed(),
    debug: has('--debug'),
    moves: get('--moves'),
    auto: has('--auto'),
    n: Number(get('--n') ?? '1'),
    // Seconds of game-time per bot action (advances the clock + regen). Auto-play needs > 0
    // or the bot goes broke and stalls; interactive/scripted modes don't tick at all.
    spm: Number(get('--spm') ?? '1'),
  }
}

function fmtTime(s: number): string {
  const sec = Math.max(0, Math.ceil(s))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

/** Render a snapshot as an ASCII grid. In debug mode, mine cells (from `mineSet`) are marked. */
function render(snap: BoardSnapshot, cfg: (typeof DIFFICULTIES)[Difficulty], mineSet: Set<string> | null): string {
  const cell = (t: TileView): string => {
    const isMine = mineSet?.has(`${t.coord.x},${t.coord.y}`)
    switch (t.state) {
      case 'armed':
        return `M${t.mineCharge ?? 1}`
      case 'detonated':
        return '##'
      case 'cleared':
        return t.number === undefined ? ' ·' : t.number === 0 ? ' .' : ` ${t.number}`
      case 'cracked': {
        const ch = TIER_CHAR[t.tier] ?? '?'
        return (isMine ? '✱' : ch.toUpperCase()) + '~' // damaged (uppercase + ~)
      }
      default: {
        if (t.isHook) return 'H '
        const ch = TIER_CHAR[t.tier] ?? '?'
        return (isMine ? '✱' : ch) + ' '
      }
    }
  }
  const lines: string[] = []
  const header = '    ' + Array.from({ length: snap.width }, (_, x) => String(x).padStart(2)).join(' ')
  lines.push(header)
  for (let y = 0; y < snap.height; y++) {
    const row = snap.tiles.slice(y * snap.width, (y + 1) * snap.width).map(cell).join(' ')
    lines.push(`${String(y).padStart(2)}  ${row}`)
  }
  const hud =
    `Charge ${snap.playerCharge}/${cfg.maxPlayerCharge}  Time ${fmtTime(snap.timeElapsed)}  ` +
    `Boss ${snap.bossHp}/${snap.bossMaxHp}  Hooks ${snap.hookCharges}  Moves ${snap.moves}  [${snap.status}]`
  return `${hud}\n${lines.join('\n')}`
}

function mineSetFor(diff: Difficulty, seed: string): Set<string> {
  const b = generateBoard(DIFFICULTIES[diff], seed)
  return new Set(b.tiles.filter(t => t.isMine).map(t => `${t.x},${t.y}`))
}

/** Apply one command string. `t x,y` tap · `d x,y` detonate · `h x,y[ dx dy]` hook (dir defaults
 *  toward the Boss; e.g. `h 4,3 1 0` hooks east). */
function applyCommand(engine: MinesweeperEngine, cmd: string): string {
  const m = cmd.match(/^([tdh])\s*(\d+)\s*,\s*(\d+)(?:\s+(-?\d+)\s+(-?\d+))?$/i)
  if (!m) return `? "${cmd}"`
  const [, kind, xs, ys, dxs, dys] = m
  const coord = { x: Number(xs), y: Number(ys) }
  const k = kind!.toLowerCase()
  let events
  if (k === 't') events = engine.reveal(coord)
  else if (k === 'd') events = engine.detonate(coord)
  else {
    const s = engine.snapshot()
    const dir =
      dxs !== undefined
        ? { x: Number(dxs), y: Number(dys) }
        : { x: Math.sign(((s.width - 1) >> 1) - coord.x), y: Math.sign(((s.height - 1) >> 1) - coord.y) }
    events = engine.useHook(coord, dir)
  }
  const kinds = events.map(e => e.kind)
  return `${cmd} → ${kinds.length ? kinds.join(',') : 'no-op'}`
}

// ---- auto-play (bot) --------------------------------------------------------

function runAuto(diff: Difficulty, seed: string, spm: number): ReturnType<MinesweeperEngine['result']> {
  let t = 0
  const engine = createEngine({ difficulty: diff, seed, now: () => t })
  let stuck = 0
  let lastSig = ''
  for (let i = 0; i < 5000; i++) {
    const snap = engine.snapshot()
    if (snap.status !== 'playing') break
    const action = autoPlay(snap)
    if (action) {
      if (action.type === 'reveal') engine.reveal(action.coord)
      else if (action.type === 'hook') engine.useHook(action.coord, action.dir ?? { x: 0, y: 0 })
      else engine.detonate(action.coord)
    }
    t += spm
    engine.tick(spm) // advance time even on a null move — lets charge regen
    const s = engine.snapshot()
    let cleared = 0
    let crack10 = 0
    for (const x of s.tiles) {
      if (x.state === 'cleared' || x.state === 'detonated') cleared++
      if (x.crack !== undefined) crack10 += Math.round(x.crack * 10)
    }
    const sig = `${cleared}|${crack10}|${s.playerCharge}`
    stuck = sig === lastSig ? stuck + 1 : 0
    lastSig = sig
    if (stuck >= 30) break // genuinely stuck (no regen, no moves)
  }
  return engine.result()
}

function autoSweep(diff: Difficulty, n: number, spm: number): void {
  const times: number[] = []
  let movesSum = 0
  for (let i = 0; i < n; i++) {
    const r = runAuto(diff, `cli-${diff}-${i}`, spm)
    times.push(r?.timeSeconds ?? 0)
    movesSum += r?.moves ?? 0
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)] ?? 0
  const avg = Math.round(times.reduce((s, t) => s + t, 0) / n)
  console.log(
    `[${diff}] bot over ${n}: median ${median}s  avg ${avg}s  ` +
      `(fastest ${times[0]}s, slowest ${times[times.length - 1]}s)  avg moves ${Math.round(movesSum / n)}`,
  )
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cfg = DIFFICULTIES[args.diff]

  if (args.auto) {
    if (args.n > 1) autoSweep(args.diff, args.n, args.spm)
    else {
      const r = runAuto(args.diff, args.seed, args.spm)
      console.log(`[${args.diff}] seed=${args.seed}`, JSON.stringify(r, null, 2))
    }
    return
  }

  const engine = createEngine({
    difficulty: args.diff,
    seed: args.seed,
    now: () => Date.now() / 1000,
    revealHooks: args.debug, // --debug marks hooks (H), like it marks mines (✱)
  })
  const mineSet = args.debug ? mineSetFor(args.diff, args.seed) : null
  const show = (): void => console.log('\n' + render(engine.snapshot(), cfg, mineSet) + '\n')

  console.log(`Inner Land Minesweeper — ${args.diff}, seed=${args.seed}${args.debug ? ' (debug: ✱ = mine)' : ''}`)
  console.log('Legend: c/a/e/f=Common/Advanced/Elite/Fleet  B=Boss  M#=armed mine  #=crater  X~=damaged')

  if (args.moves) {
    for (const cmd of args.moves.trim().split(/\s+/)) console.log(applyCommand(engine, cmd))
    show()
    return
  }

  show()
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  rl.prompt()
  rl.on('line', line => {
    const cmd = line.trim()
    if (cmd === 'q') return rl.close()
    if (cmd === 'p') show()
    else if (cmd === 'n') {
      console.log('(restart the CLI for a new seed)')
    } else if (cmd) {
      console.log(applyCommand(engine, cmd))
      show()
    }
    rl.prompt()
  })
}

void main()
