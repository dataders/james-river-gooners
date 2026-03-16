const FAR_KEYWORDS = [
  'earlysville',
  'charlottesville',
  'waynesboro',
  'staunton',
  'lynchburg',
  'fredericksburg',
  'roanoke',
  'harrisonburg',
]

export function isLocalAuction(title) {
  if (!title) return true
  const lower = title.toLowerCase()
  return !FAR_KEYWORDS.some(kw => lower.includes(kw))
}
