import { defineConfig } from 'vite'

// Build the embeddable host (src/embed) as a self-contained bundle with RELATIVE asset paths, so
// the output can be dropped under any sub-path of a host site's `public/` (the Tower Run Tracker
// serves it from `public/games/inner-land-minesweeper/`). See src/embed/main.ts for the postMessage
// protocol the host consumes. `pnpm build:embed` writes to ./dist-embed.
export default defineConfig({
  root: 'src/embed',
  base: './',
  build: {
    outDir: '../../dist-embed',
    emptyOutDir: true,
  },
})
