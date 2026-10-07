import '../ui/styles.css'
import { GameApp } from '../ui/game-app'

import type { Difficulty } from '../engine/types'

const params = new URLSearchParams(globalThis.location?.search ?? '')
const root = document.getElementById('app')!

const opts: ConstructorParameters<typeof GameApp>[1] = { onResult: r => console.log('[GameResult]', r) }
const diff = params.get('difficulty')
if (diff === 'gentle' || diff === 'standard' || diff === 'hard') opts.difficulty = diff as Difficulty
const seed = params.get('seed')
if (seed) opts.seed = seed

const app = new GameApp(root, opts)

const fullscreen = document.createElement('button')
fullscreen.type = 'button'
fullscreen.className = 'ilm-btn ilm-fullscreen'
fullscreen.textContent = 'Fullscreen'
fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen()
    else fullscreen.textContent = 'Full window'
  } catch {
    fullscreen.textContent = 'Full window'
  }
})
root.querySelector('.ilm-header__actions')?.prepend(fullscreen)
document.addEventListener('fullscreenchange', () => {
  fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'
  window.dispatchEvent(new Event('resize'))
})

// Expose for poking in the console during development.
;(globalThis as unknown as { ilm: GameApp }).ilm = app

// ?demo=1 auto-starts the watch-demo.
if (params.get('demo') === '1') (app as unknown as { startDemo: () => void }).startDemo()
