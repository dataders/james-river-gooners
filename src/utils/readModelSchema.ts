// Runtime validation at the read-model boundary.
//
// The browser loads lots as untyped JSON — Supabase view rows in prod, NDJSON
// in the offline fallback — and normalizes them into `Item`s (auctionNormalize).
// TypeScript describes the shape we *expect*, but can't guarantee the bytes that
// actually arrive match it. This schema is that guarantee: a lot missing its
// load-bearing fields is dropped at the boundary with a clear, located reason,
// instead of surfacing as `undefined` deep in the virtualized grid (or crashing
// the MiniSearch index with a duplicate/empty id).
//
// Deliberately minimal + lenient (`looseObject`): it asserts only the fields the
// grid, the `${auctionSafeId}:${id}` composite key, dedupe, search index, and
// favorites actually depend on. Every other field — enrichment, comps, the full
// image set — rides along untouched. Matching the codebase's existing ethos
// (fetchNdjson skips a malformed line, allItems de-dupes defensively), a bad row
// is dropped-and-reported, never thrown.

import * as v from 'valibot'
import type { Item } from '../types.ts'

const ItemSchema = v.looseObject({
  // The two halves of itemKey — both must be present and non-empty or the lot
  // gets a broken/colliding key. This is the invariant that actually matters.
  id: v.pipe(v.string(), v.nonEmpty()),
  auctionSafeId: v.pipe(v.string(), v.nonEmpty()),
  title: v.string(),
  // normalize coerces these to numbers; assert the coercion held.
  currentBid: v.number(),
  totalBids: v.number(),
  images: v.array(v.string()),
})

// Compile-time guard: every field the schema requires must be a real `Item`
// field. A typo like `auctionSafeID` would fail here — at build time — rather
// than silently dropping every row at runtime.
type SchemaKeysAreItemKeys = keyof typeof ItemSchema.entries extends keyof Item
  ? true
  : never
const _schemaKeysAreItemKeys: SchemaKeysAreItemKeys = true
void _schemaKeysAreItemKeys

export interface ItemValidation {
  /** Items that passed (original objects, untouched). */
  valid: Item[]
  /** How many were dropped. */
  invalidCount: number
  /** First few human-readable drop reasons (capped). */
  sampleReasons: string[]
}

const MAX_SAMPLE_REASONS = 5

/**
 * Partition normalized items into those safe to render and those to drop.
 * Pure — telemetry/logging is the caller's job (see useAuctionData).
 */
export function validateItems(items: Item[]): ItemValidation {
  const valid: Item[] = []
  let invalidCount = 0
  const sampleReasons: string[] = []

  for (const item of items) {
    const result = v.safeParse(ItemSchema, item)
    if (result.success) {
      valid.push(item)
      continue
    }
    invalidCount++
    if (sampleReasons.length < MAX_SAMPLE_REASONS) {
      const issue = result.issues[0]
      const where = issue?.path?.map((p) => String(p.key)).join('.') || '(row)'
      // item may be malformed; read its key fields defensively.
      const raw = item as Partial<Item>
      const key = `${raw?.auctionSafeId ?? '?'}:${raw?.id ?? '?'}`
      sampleReasons.push(`${key} — ${where}: ${issue?.message ?? 'invalid'}`)
    }
  }

  return { valid, invalidCount, sampleReasons }
}
