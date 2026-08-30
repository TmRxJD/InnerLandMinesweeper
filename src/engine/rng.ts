/**
 * Deterministic seeded RNG. Same seed → same sequence, on every platform, forever.
 *
 * Uses xmur3 to hash a string seed into a 32-bit state, then mulberry32 as the generator.
 * Both are tiny, well-distributed, and dependency-free. This is the *only* source of
 * randomness the engine is allowed to use — `Math.random()` never appears in game logic,
 * so a seed fully reproduces a run (required for the harness, shareable boards, dailies).
 */

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Rng {
  private next: () => number

  constructor(seed: string) {
    const seedFn = xmur3(seed)
    this.next = mulberry32(seedFn())
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next()
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p
  }

  /** Pick a key by relative weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][]
    const total = entries.reduce((sum, [, w]) => sum + w, 0)
    let roll = this.next() * total
    for (const [key, w] of entries) {
      roll -= w
      if (roll < 0) return key
    }
    return entries[entries.length - 1]![0]
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      const tmp = arr[i]!
      arr[i] = arr[j]!
      arr[j] = tmp
    }
    return arr
  }
}

/** Generate a fresh random seed string (used when no seed is supplied by a host). */
export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}
