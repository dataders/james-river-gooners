// Shared PostgREST pagination. The browser reads several per-auction Supabase
// views (eBay comps, Cannon's comps, lot enrichment) that can each exceed
// PostgREST's 1000-row response cap, so every reader pages until a short page
// comes back. This was copy-pasted into the per-auction readers (compsLoader +
// the comps/enrichment hooks); it now lives here once for those. The whole-
// dataset loader (useAuctionData's fetchAllFromView) keeps its own variant on
// purpose: it advances by rows-actually-returned and is being reworked into
// parallel paging separately (#243).
//
// The helper is decoupled from the Supabase client on purpose: callers pass a
// `makePage(from, to)` closure that runs whatever query they need (table,
// columns, filters). That keeps this file free of any client/browser
// dependency, so it's trivially unit-testable with a stub closure — and lets
// the real `supabase.from(...).select(...).eq(...).range(from, to)` chain and a
// hand-rolled test stub satisfy the same tiny contract.

export const PAGE_SIZE = 1000

/** One page response, the subset of PostgREST's result we depend on. */
interface PageResult {
  data: unknown[] | null
  error: unknown
}

/** Runs one `.range(from, to)` query. PromiseLike so the Supabase query builder
 *  (a thenable, not a real Promise) is assignable without a cast. */
type PageFetcher = (from: number, to: number) => PromiseLike<PageResult>

/**
 * Read every row matching `makePage`, paging in PAGE_SIZE windows until a page
 * returns fewer than PAGE_SIZE rows. Rejects (throws) on the first page error so
 * callers can decide whether to swallow it; the read-model loaders catch and
 * return an empty result so one failure never blanks the grid.
 */
export async function fetchAllRows(makePage: PageFetcher): Promise<unknown[]> {
  const rows: unknown[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makePage(from, from + PAGE_SIZE - 1)
    // Deliberately rethrows the opaque PostgREST error (a plain object, not an
    // Error instance) so callers can decide whether to swallow it — see docstring.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}
