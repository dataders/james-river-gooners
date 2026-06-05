import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  optimizeDeps: {
    // Scan only the real app entry. Without this, Vite's dep scanner globs
    // every *.html in the project — including the standalone Babel-in-browser
    // demo at public/dashboard.html, whose inline JSX isn't valid plain JS and
    // throws a PARSE_ERROR that can break dev-server pre-bundling (blank page).
    entries: ['index.html'],
    exclude: ['@huggingface/transformers'],
  },
  worker: {
    format: 'es',
  },
})
