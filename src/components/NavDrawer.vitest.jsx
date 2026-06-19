// @ts-nocheck
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { NavDrawer } from './NavDrawer.jsx'

const loggedOutAuth = { available: true, user: null }
const loggedInAuth = { available: true, user: { email: 'a@b.com' }, signOut: vi.fn(), changePassword: vi.fn() }

function baseProps(over = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onImageSearch: vi.fn(),
    onSwipe: vi.fn(),
    onTutorial: vi.fn(),
    onWhatsNew: vi.fn(),
    whatsNewUnseen: false,
    theme: 'light',
    onToggleTheme: vi.fn(),
    auth: loggedOutAuth,
    cannonBids: null,
    onSignInClick: vi.fn(),
    onCannonLinkClick: vi.fn(),
    ...over,
  }
}

describe('NavDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<NavDrawer {...baseProps({ open: false })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('logged out shows a Sign in action that fires and closes', () => {
    const p = baseProps()
    render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(p.onSignInClick).toHaveBeenCalledOnce()
    expect(p.onClose).toHaveBeenCalledOnce()
  })

  it('logged in shows the account email', () => {
    render(<NavDrawer {...baseProps({ auth: loggedInAuth })} />)
    expect(screen.getByText('a@b.com')).toBeInTheDocument()
  })

  it('a utility action fires its callback and closes the drawer', () => {
    const p = baseProps()
    render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Search by photo' }))
    expect(p.onImageSearch).toHaveBeenCalledOnce()
    expect(p.onClose).toHaveBeenCalledOnce()
  })

  it('theme toggle fires onToggleTheme but does NOT close the drawer', () => {
    const p = baseProps()
    render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /theme/i }))
    expect(p.onToggleTheme).toHaveBeenCalledOnce()
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('backdrop click and Escape both close', () => {
    const p = baseProps()
    const { rerender } = render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByTestId('nav-drawer-overlay'))
    expect(p.onClose).toHaveBeenCalledOnce()
    rerender(<NavDrawer {...baseProps({ onClose: p.onClose })} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(p.onClose).toHaveBeenCalledTimes(2)
  })

  it("What's new shows the New badge only when unseen", () => {
    const { rerender } = render(<NavDrawer {...baseProps({ whatsNewUnseen: true })} />)
    expect(screen.getByText('New')).toBeInTheDocument()
    rerender(<NavDrawer {...baseProps({ whatsNewUnseen: false })} />)
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })
})
