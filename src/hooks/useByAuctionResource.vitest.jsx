import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useByAuctionResource } from './useByAuctionResource.ts'

function wrapperFor(client) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('useByAuctionResource (TanStack Query)', () => {
  it('builds a { [auctionSafeId]: payload } map once fetches resolve', async () => {
    const fetchOne = vi.fn(async (id) => ({ id, items: { hello: id } }))
    const { result } = renderHook(
      () => useByAuctionResource('test', ['a1', 'a2'], fetchOne),
      { wrapper: wrapperFor(freshClient()) },
    )

    await waitFor(() => {
      expect(result.current).toEqual({ a1: { hello: 'a1' }, a2: { hello: 'a2' } })
    })
    expect(fetchOne).toHaveBeenCalledTimes(2)
  })

  it('returns a stable EMPTY identity (and skips fetching) when disabled', () => {
    const fetchOne = vi.fn(async (id) => ({ id, items: {} }))
    const { result, rerender } = renderHook(
      () => useByAuctionResource('test', ['a1'], fetchOne, false),
      { wrapper: wrapperFor(freshClient()) },
    )
    const first = result.current
    rerender()
    expect(result.current).toBe(first) // same reference across renders
    expect(fetchOne).not.toHaveBeenCalled()
  })

  it('keeps the map reference stable across re-renders that do not change data', async () => {
    const fetchOne = vi.fn(async (id) => ({ id, items: { v: id } }))
    const { result, rerender } = renderHook(
      () => useByAuctionResource('test', ['a1', 'a2'], fetchOne),
      { wrapper: wrapperFor(freshClient()) },
    )
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2))
    const loaded = result.current
    rerender()
    expect(result.current).toBe(loaded) // identity preserved → downstream memos hold
  })

  it('re-exposes cached data instantly when re-enabled, without refetching', async () => {
    const fetchOne = vi.fn(async (id) => ({ id, items: { v: id } }))
    const client = freshClient()
    const { result, rerender } = renderHook(
      ({ enabled }) => useByAuctionResource('test', ['a1'], fetchOne, enabled),
      { wrapper: wrapperFor(client), initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current).toEqual({ a1: { v: 'a1' } }))
    expect(fetchOne).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    expect(result.current).toEqual({}) // gated off

    rerender({ enabled: true })
    expect(result.current).toEqual({ a1: { v: 'a1' } }) // from cache
    expect(fetchOne).toHaveBeenCalledTimes(1) // no refetch
  })
})
