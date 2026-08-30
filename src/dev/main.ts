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

// Expose for poking in the console during development.
;(globalThis as unknown as { ilm: GameApp }).ilm = app

// ?demo=1 auto-starts the watch-demo.
if (params.get('demo') === '1') (app as unknown as { startDemo: () => void }).startDemo()
