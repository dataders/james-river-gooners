// Standalone entry for the owner-only admin dashboard at /admin.
//
// This is a SEPARATE Vite entry (see vite.config.js rollupOptions.input) so the
// admin route is a real URL on GitHub Pages (dist/admin/index.html) without a
// client router, and none of the main auction-browsing bundle is pulled in.
//
// The dashboard data never ships here: AdminDashboard streams a pre-built HTML
// file from a PRIVATE Supabase Storage bucket that only the signed-in owner can
// read (RLS, migration 0020). Logged out or signed in as anyone else → the
// download returns nothing and the gate is shown.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { AdminDashboard } from './components/AdminDashboard.jsx'
import { ErrorBoundary } from './components/ErrorBoundary.jsx'
import { queryClient } from './lib/queryClient.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AdminDashboard />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
