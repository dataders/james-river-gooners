import type { ComponentType } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ItemCard } from './ItemCard.jsx'
import { ItemDetail } from './ItemDetail.jsx'
import { ImageSearchModal } from './ImageSearchModal.jsx'

vi.mock('../hooks/useFullImages.js', () => ({
  useFullImages: (item: { images?: string[] } | null | undefined) => item?.images ?? [],
}))

vi.mock('../hooks/useImageSearch.js', () => ({
  useImageSearch: () => ({
    analyzeImage: vi.fn(),
    loading: false,
    error: null,
    clear: vi.fn(),
    result: {
      brand: 'Ping',
      model: 'G425',
      category: 'Golf',
      searchTerms: 'Ping G425 driver',
      searchQuery: 'Ping G425 driver',
      facebookComps: [
        {
          id: 'fb-sold-1',
          title: 'Ping G425 Max Driver',
          price_value: 190,
          price_label: '$190',
          sold_date: '2026-06-01',
          thumbnail_url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
          listing_url: 'https://www.facebook.com/marketplace/item/fb-sold-1/',
        },
      ],
    },
  }),
}))

const IMG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'

function facebookItem(over: Record<string, unknown> = {}) {
  return {
    id: 'fb-1',
    auctionSafeId: 'facebook_golf',
    title: 'Ping G425 Driver',
    category: 'Facebook Marketplace',
    rawCategory: 'Facebook Marketplace',
    currentBid: 185,
    totalBids: 0,
    uniqueBidders: 0,
    images: [IMG],
    source: 'facebook',
    detailUrl: 'https://www.facebook.com/marketplace/item/fb-1/',
    searchQuery: 'Ping G425 driver',
    ...over,
  }
}

describe('Facebook Marketplace UI', () => {
  it('renders Facebook item cards as outbound listings without bid metadata', () => {
    const TestItemCard = ItemCard as ComponentType<Record<string, unknown>>
    render(
      <TestItemCard
        item={facebookItem()}
        isFavorite={false}
        isIgnored={false}
        onToggleFavorite={vi.fn()}
        onToggleIgnored={vi.fn()}
        onItemClick={vi.fn()}
      />,
    )

    expect(screen.getByText('Facebook Marketplace')).toBeTruthy()
    const link = screen.getByRole('link', { name: /open listing/i })
    expect(link.getAttribute('href')).toBe('https://www.facebook.com/marketplace/item/fb-1/')
    expect(screen.queryByText(/bids?/i)).toBeNull()
  })

  it('renders a sold Facebook comps search link on item detail', () => {
    const TestItemDetail = ItemDetail as unknown as ComponentType<Record<string, unknown>>
    render(
      <TestItemDetail
        item={facebookItem({ source: 'cannons' })}
        ebayComps={{}}
        cannonsComps={{}}
        categoryStats={null}
        margin={0.4}
        locked={false}
        onSignInClick={vi.fn()}
        cannonBids={null}
        bidStatus={null}
        user={null}
        onCannonLinkClick={vi.fn()}
        isFavorite={false}
        isIgnored={false}
        onClose={vi.fn()}
        onToggleFavorite={vi.fn()}
        onToggleIgnored={vi.fn()}
      />,
    )

    const link = screen.getByRole('link', { name: /search facebook comps/i })
    expect(link.getAttribute('href')).toBe(
      'https://www.facebook.com/marketplace/richmond/search?availability=out%20of%20stock&query=Ping%20G425%20driver&exact=true',
    )
  })

  it('renders sold Facebook comps returned by image search', () => {
    render(
      <ImageSearchModal
        onClose={vi.fn()}
        items={[]}
        user={{ id: 'user-1' }}
        onSearchInGrid={vi.fn()}
        onSignInClick={vi.fn()}
      />,
    )

    expect(screen.getByText(/sold on facebook/i)).toBeTruthy()
    expect(screen.getByText('Ping G425 Max Driver')).toBeTruthy()
    expect(screen.getByText(/\$190 sold/i)).toBeTruthy()
  })
})
