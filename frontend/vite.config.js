import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Versions-Single-Source ist die Root-package.json. Wir lesen sie hier direkt (statt
// process.env.npm_package_version, das je nach npm-Aufrufkontext leer/falsch waere) und
// injizieren sie zur Build-Zeit als globale Konstante __APP_VERSION__ (vite `define`,
// nicht import.meta.env). Der Header liest daraus WIKI_VERSION (s. config.js).
const rootPkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
)

// Dev: Vite auf :5173, API-Aufrufe werden an den Express-Server (:3000) geproxyt.
// Build: statische Dateien nach dist/, die der Express-Server in Produktion ausliefert.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
