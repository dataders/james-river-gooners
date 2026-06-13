import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.jsx'
import { ErrorBoundary } from './components/ErrorBoundary.jsx'
import { queryClient } from './lib/queryClient.js'
import { initAnalytics } from './lib/telemetry.js'

// Anonymous, cookieless telemetry. No-ops when VITE_POSTHOG_KEY is unset.
// Deferred to idle time so the PostHog bundle never competes with the first
// paint or the auction-data fetch on the critical path.
const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1))
idle(() => initAnalytics())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
