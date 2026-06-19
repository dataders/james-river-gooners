// @ts-nocheck
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AccountMenuBody } from './AccountMenuBody.jsx'

function makeAuth(over = {}) {
  return { available: true, user: { email: 'a@b.com' }, signOut: vi.fn(), changePassword: vi.fn(), ...over }
}

describe('AccountMenuBody', () => {
  it('shows the user email', () => {
    render(<AccountMenuBody auth={makeAuth()} cannonBids={null} />)
    expect(screen.getByText('a@b.com')).toBeInTheDocument()
  })

  it('sign out calls auth.signOut then onAfterAction', () => {
    const auth = makeAuth()
    const onAfterAction = vi.fn()
    render(<AccountMenuBody auth={auth} cannonBids={null} onAfterAction={onAfterAction} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(auth.signOut).toHaveBeenCalledOnce()
    expect(onAfterAction).toHaveBeenCalledOnce()
  })

  it("Link Cannon's account fires the callback and closes", () => {
    const onCannonLinkClick = vi.fn()
    const onAfterAction = vi.fn()
    render(<AccountMenuBody auth={makeAuth()} cannonBids={{ linked: false }} onCannonLinkClick={onCannonLinkClick} onAfterAction={onAfterAction} />)
    fireEvent.click(screen.getByRole('menuitem', { name: "Link Cannon's account" }))
    expect(onCannonLinkClick).toHaveBeenCalledOnce()
    expect(onAfterAction).toHaveBeenCalledOnce()
  })
})
