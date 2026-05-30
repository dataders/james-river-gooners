const FAR_KEYWORDS = [
  'earlysville',
  'charlottesville',
  'waynesboro',
  'staunton',
  'lynchburg',
  'fredericksburg',
  'roanoke',
  'harrisonburg',
  'gordonsville',
  'orange county',
  'culpeper',
  'louisa',
  'emporia',
  'south hill',
  'chase city',
]

export function isLocalAuction(title) {
  if (!title) return true
  const lower = title.toLowerCase()
  return !FAR_KEYWORDS.some(kw => lower.includes(kw))
}
