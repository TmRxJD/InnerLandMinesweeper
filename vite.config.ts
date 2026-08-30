import { defineConfig } from 'vite'

// The dev host lives in src/dev; the engine + ui are consumed as source from there.
export default defineConfig({
  root: 'src/dev',
  server: { port: 5180 },
  build: {
    outDir: '../../dist-dev',
    emptyOutDir: true,
  },
})
