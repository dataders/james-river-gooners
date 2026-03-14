import { useState, useEffect } from 'react'

const BASE = import.meta.env.BASE_URL

export function useAuctionData() {
  const [auctions, setAuctions] = useState([])
  const [selectedAuctionId, setSelectedAuctionId] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Load auctions list
  useEffect(() => {
    fetch(`${BASE}data/auctions.json`)
      .then(r => r.json())
      .then(data => {
        setAuctions(data)
        if (data.length > 0) {
          setSelectedAuctionId(data[0].safeId)
        }
      })
      .catch(e => setError(e.message))
  }, [])

  // Load items when auction is selected
  useEffect(() => {
    if (!selectedAuctionId) return
    setLoading(true)
    fetch(`${BASE}data/items/${selectedAuctionId}.json`)
      .then(r => r.json())
      .then(data => {
        setItems(data)
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [selectedAuctionId])

  return {
    auctions,
    selectedAuctionId,
    setSelectedAuctionId,
    items,
    loading,
    error,
  }
}
