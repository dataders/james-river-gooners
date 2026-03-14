export function AuctionPicker({ auctions, selectedId, onSelect }) {
  if (auctions.length <= 1) return null

  return (
    <select
      className="auction-picker"
      value={selectedId || ''}
      onChange={e => onSelect(e.target.value)}
    >
      {auctions.map(a => (
        <option key={a.safeId} value={a.safeId}>
          {a.title} ({a.totalItems} items)
        </option>
      ))}
    </select>
  )
}
