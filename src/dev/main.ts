import '../ui/styles.css'
import { GameApp } from '../ui/game-app'

const root = document.getElementById('app')!
const app = new GameApp(root, {
  difficulty: 'gentle',
  onResult: r => console.log('[GameResult]', r),
})

// Expose for poking in the console during development.
;(globalThis as unknown as { ilm: GameApp }).ilm = app
