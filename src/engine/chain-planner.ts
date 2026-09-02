/**
 * The chain brain. This game is not "clear the tiles" — it is a combo puzzle: the skill is finding a
 * detonation ORDER (and the hook setup that enables it) where one sequence cascades through the most
 * enemies, outer mines pumping inner ones into a fat blast, each detonation setting up the next — the
 * "many jumps in one move" of checkers. Everything a smart player does is in service of a big clean
 * chain, including delivering one into the Boss.
 *
 * `bestChain` searches that space directly. It plays hypothetical detonation orders forward on cloned
 * engines (so the cascade — arming/pumping neighbours, radius, shrapnel, the shield — is modelled by
 * the REAL engine, never a hand-ported copy that could drift) and returns the order that scores best.
 * The rest of the AI is then simple: execute the best chain, or make the move (a hook, a reveal) that
 * most improves the best chain available.
 */

import type { BoardSnapshot, Coord, MinesweeperEngine } from './types'

export interface ChainResult {
  /** The detonation order to play, best first. Empty when nothing is armed. */
  readonly sequence: Coord[]
  /** Net score of that order — enemies killed + Boss damage, minus a per-mine spend cost. */
  readonly value: number
  /** Field enemies the sequence removes. */
  readonly killed: number
  /** Boss shield charges stripped + HP dealt, across the sequence. */
  readonly bossHits: number
}

export interface ChainOptions {
  /** How many partial orders to keep between plies. Wider = better order found, slower. */
  readonly beamWidth?: number
  /** Max detonations deep to look. A chain rarely needs more than the armed-mine count. */
  readonly maxDepth?: number
  /** Value of a Boss HP point, in enemies-killed units — HP damage is the scarce, decisive resource. */
  readonly hpWeight?: number
  /** Value of stripping one shield charge. */
  readonly shieldWeight?: number
  /** Cost charged per detonation (a spent mine), so the search prefers FEW big blasts over many
   *  small ones — the "cleanest chain", not merely the highest body count. */
  readonly spendCost?: number
  /** Coords (by `key`) the chain must NOT detonate — the mines reserved for the Boss run, so a field
   *  cascade never cashes in the ordnance being gathered for the kill. */
  readonly exclude?: ReadonlySet<number>
}

const DEFAULTS = {
  beamWidth: 5,
  maxDepth: 14,
  hpWeight: 10,
  shieldWeight: 3,
  spendCost: 1.5,
} as const

const key = (c: Coord): number => c.y * 1000 + c.x

function standingEnemies(s: BoardSnapshot): number {
  let n = 0
  for (const t of s.tiles) if ((t.state === 'covered' || t.state === 'cracked') && t.tier !== 'boss') n++
  return n
}

export interface KeystoneResult {
  /** Detonation order (best first) that pumps the keystone the most, never touching it. */
  readonly sequence: Coord[]
  /** The stack the keystone reaches after that order. */
  readonly stack: number
}

/**
 * Build a fat keystone WITHOUT hooks: search detonation orders (never detonating the keystone itself)
 * that pump the armed mine at `keystone` to the biggest stack. Detonating a mine within reach of the
 * keystone overlaps-charges it, and each blast also arms covered mines nearby that the next ply can
 * fire in turn — so a natural field cluster snowballs one survivor toward the stack cap. Play the
 * first move of the returned sequence; the pumpers are ordnance you already have, so this costs no
 * hooks — only the finished keystone gets hooked to the Boss. Empty sequence when nothing pumps it.
 */
export function buildKeystone(engine: MinesweeperEngine, keystone: Coord, opts: { beamWidth?: number; maxDepth?: number } = {}): KeystoneResult {
  const beamWidth = opts.beamWidth ?? 6
  const maxDepth = opts.maxDepth ?? 8
  const kKey = key(keystone)
  const stackOf = (s: BoardSnapshot): number => {
    const t = s.tiles.find(t => t.coord.x === keystone.x && t.coord.y === keystone.y)
    return t && t.state === 'armed' ? t.mineCharge ?? 1 : 0
  }
  let best: KeystoneResult = { sequence: [], stack: stackOf(engine.snapshot()) }
  let beam: { eng: MinesweeperEngine; seq: Coord[]; stack: number }[] = [{ eng: engine, seq: [], stack: best.stack }]
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: { eng: MinesweeperEngine; seq: Coord[]; stack: number }[] = []
    for (const node of beam) {
      const sn = node.eng.snapshot()
      if (sn.status !== 'playing') continue
      for (const t of sn.tiles) {
        if (t.state !== 'armed' || key(t.coord) === kKey) continue
        const eng2 = node.eng.clone()
        eng2.detonate(t.coord)
        const kstack = stackOf(eng2.snapshot())
        if (kstack === 0) continue // keystone gone (shouldn't happen — blasts pump armed mines) — drop
        const seq2 = [...node.seq, t.coord]
        if (kstack > best.stack || (kstack === best.stack && seq2.length < best.sequence.length)) {
          best = { sequence: seq2, stack: kstack }
        }
        next.push({ eng: eng2, seq: seq2, stack: kstack })
      }
    }
    if (next.length === 0) break
    next.sort((a, b) => b.stack - a.stack)
    beam = next.slice(0, beamWidth)
  }
  return best
}

interface Node {
  eng: MinesweeperEngine
  seq: Coord[]
  raw: number // kills + boss value of this state vs the start (no spend cost) — for beam ranking
}

/**
 * Search detonation orders from the live position and return the best one to play. Only ARMED mines
 * can start a chain; detonating one may arm/pump its neighbours, which the next ply then considers, so
 * the beam naturally discovers "detonate the outer ones to fatten the core, then fire the core".
 */
export function bestChain(engine: MinesweeperEngine, opts: ChainOptions = {}): ChainResult {
  const o = { ...DEFAULTS, ...opts }
  const start = engine.snapshot()
  const startEnemies = standingEnemies(start)
  const startShield = start.bossShield
  const startHp = start.bossHp

  // Raw impact of a state vs the start (enemies removed + boss damage), before the per-mine spend cost.
  const raw = (s: BoardSnapshot): number => {
    const killed = startEnemies - standingEnemies(s)
    const shield = startShield - s.bossShield
    const hp = startHp - s.bossHp
    return killed + shield * o.shieldWeight + hp * o.hpWeight
  }
  // Net score the AI actually maximises: impact minus the mines the order spent.
  const net = (rawVal: number, dets: number): number => rawVal - dets * o.spendCost

  let best: ChainResult = { sequence: [], value: 0, killed: 0, bossHits: 0 }
  let beam: Node[] = [{ eng: engine, seq: [], raw: 0 }]

  for (let depth = 0; depth < o.maxDepth; depth++) {
    const next: Node[] = []
    for (const node of beam) {
      const sn = node.eng.snapshot()
      if (sn.status !== 'playing') continue
      for (const t of sn.tiles) {
        if (t.state !== 'armed') continue
        if (o.exclude && o.exclude.has(key(t.coord))) continue // reserved for the Boss — never field-fire it
        const eng2 = node.eng.clone()
        eng2.detonate(t.coord)
        const sn2 = eng2.snapshot()
        const seq2 = [...node.seq, t.coord]
        const rawVal = raw(sn2)
        const value = net(rawVal, seq2.length)
        if (value > best.value) {
          best = {
            sequence: seq2,
            value,
            killed: startEnemies - standingEnemies(sn2),
            bossHits: startShield - sn2.bossShield + (startHp - sn2.bossHp),
          }
        }
        next.push({ eng: eng2, seq: seq2, raw: rawVal })
      }
    }
    if (next.length === 0) break
    // Keep the most impactful partial orders to extend next ply (dedup identical detonation SETs so the
    // beam doesn't waste width on the same cluster reached by different orders with equal impact).
    next.sort((a, b) => b.raw - a.raw)
    const seen = new Set<string>()
    beam = []
    for (const n of next) {
      const sig = n.seq.map(key).sort((a, b) => a - b).join(',')
      if (seen.has(sig)) continue
      seen.add(sig)
      beam.push(n)
      if (beam.length >= o.beamWidth) break
    }
  }
  return best
}
