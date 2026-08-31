/**
 * Embed host — the entry the Tower Run Tracker (or any host page) loads in an iframe.
 *
 * It mounts the game exactly like the dev host, but instead of logging, it speaks a tiny
 * postMessage protocol to its parent window so the host can size the frame and receive the
 * GameResult handoff:
 *
 *   → { type: 'ilm:ready' }                       once mounted
 *   → { type: 'ilm:content-height', height }      whenever the board's height changes
 *   → { type: 'ilm:result', payload: GameResult } when a run is won (time + medal)
 *
 * All messages are posted to the parent; the host validates origin on its side. The bundle is
 * built self-contained with relative asset paths (see vite.embed.config.ts) so it can be served
 * from any sub-path under the host's `public/`.
 */

import '../ui/styles.css'
import { GameApp } from '../ui/game-app'
import type { Difficulty } from '../engine/types'

const params = new URLSearchParams(globalThis.location?.search ?? '')
const root = document.getElementById('app')!

/** Post to the parent window (same-origin when served from the host's public/; '*' is fine here —
 *  the payload carries no secrets and the host re-checks origin before trusting it). */
function postToParent(message: unknown): void {
  try {
    window.parent?.postMessage(message, '*')
  } catch {
    /* no parent, or a cross-origin parent that refuses — nothing to do */
  }
}

const opts: ConstructorParameters<typeof GameApp>[1] = {
  onResult: result => postToParent({ type: 'ilm:result', payload: result }),
}
const diff = params.get('difficulty')
if (diff === 'gentle' || diff === 'standard' || diff === 'hard') opts.difficulty = diff as Difficulty
const seed = params.get('seed')
if (seed) opts.seed = seed

new GameApp(root, opts)

// Report the rendered height so the host can size the iframe to the board (which varies by
// difficulty). Debounced to a frame so a burst of layout changes posts once.
let raf = 0
function reportHeight(): void {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    const height = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0)
    if (height > 0) postToParent({ type: 'ilm:content-height', height })
  })
}
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(reportHeight)
  ro.observe(document.documentElement)
  ro.observe(root)
}
window.addEventListener('load', reportHeight)

postToParent({ type: 'ilm:ready' })
reportHeight()
