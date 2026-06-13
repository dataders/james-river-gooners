import { QueryClient } from '@tanstack/react-query'

// Single app-wide query cache. Defaults lean on the read model being
// session-stable: a scrape refreshes the data, not a tab focus, so queries opt
// into `staleTime: Infinity` at the call site (see useByAuctionResource) and we
// disable refetch-on-focus globally to avoid surprise refetches of large views.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
