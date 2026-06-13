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
  build: {
    rollupOptions: {
      output: {
        // Split rarely-changing vendor code into its own long-cached chunks so
        // a frequent app-only deploy doesn't invalidate the (large) framework +
        // SDK bytes. The semantic-search model worker is already its own chunk.
        // Function form (rolldown rejects the object shorthand).
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'vendor-react'
          if (id.includes('/@supabase/')) return 'vendor-supabase'
          if (id.includes('/posthog-js/')) return 'vendor-posthog'
          if (id.includes('/minisearch/')) return 'vendor-search'
        },
      },
    },
  },
})
