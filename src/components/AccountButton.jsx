// Header account control (issue #92). Signed out: a "Sign in" button that opens
// the auth modal. Signed in: the user's email with a "Sign out" action.

export function AccountButton({ auth, onSignInClick }) {
  if (!auth.available) return null

  if (auth.user) {
    return (
      <div className="account-control">
        <span className="account-email" title={auth.user.email}>{auth.user.email}</span>
        <button type="button" className="account-button" onClick={auth.signOut}>
          Sign out
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="account-button"
      onClick={onSignInClick}
      disabled={auth.loading}
    >
      Sign in
    </button>
  )
}
