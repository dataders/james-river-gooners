// Logged-out placeholder shown in the item detail panel in place of the
// resale-intelligence cluster (eBay sold comps, Cannon's "sold previously"
// comps, category sold-price history, and the max-bid calculator).
//
// The underlying data is gated at the source — the Supabase comps/sold views
// require an authenticated session (migration 0008), so a logged-out browser
// reads zero rows. This is the CTA that invites a sign-in to unlock it.
export function ResaleInsightsGate({ onSignInClick }) {
  return (
    <section className="resale-gate">
      <div className="resale-gate-header">
        <span className="resale-gate-lock" aria-hidden="true">🔒</span>
        <h3>Resale insights are members-only</h3>
      </div>
      <p className="resale-gate-blurb">
        Log in to see eBay sold comps, what similar lots sold for at Cannon's,
        category price history, and a max-bid calculator for this listing.
      </p>
      <button type="button" className="resale-gate-cta" onClick={onSignInClick}>
        Log in to unlock
      </button>
    </section>
  )
}
