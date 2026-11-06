// @vitest-environment jsdom
/**
 * One banner per hub whose connection has a problem, across the app: the way out
 * fits the cause (Sign in for a lost sign-in), Hub settings and Details are always
 * there, Dismiss closes it until the cause changes, Don't show again mutes the hub.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubIssueEntry } from '@slayzone/transport/client'

let issues: HubIssueEntry[] = []
vi.mock('@slayzone/transport/client', () => ({ useHubIssues: () => issues }))

const { HubIssueBanners } = await import('./HubIssueBanners')
const { useHubIssueBannerStore } = await import('./hub-issue-banner-store')

const remote = { id: 'hub:normain', kind: 'remote', label: 'slay.normain.com', url: 'wss://x/trpc' }
const local = { id: 'local', kind: 'local', label: 'This computer' }
const T0 = Date.parse('2026-11-06T10:00:00Z')

function entry(
  hub: typeof remote | typeof local,
  kind: 'unreachable' | 'signin' | 'error',
  detail = 'why'
): HubIssueEntry {
  return { hub: hub as HubIssueEntry['hub'], issue: { kind, since: T0, detail } }
}

beforeEach(() => {
  localStorage.clear()
  useHubIssueBannerStore.setState({ muted: [], dismissed: {}, pendingSignIn: null })
})
afterEach(() => {
  cleanup()
  issues = []
})

describe('HubIssueBanners', () => {
  it('shows nothing when every hub is fine', () => {
    render(<HubIssueBanners />)
    expect(screen.queryByTestId('hub-issue-banner')).toBeNull()
  })

  it('one banner per hub with an issue', () => {
    issues = [entry(local, 'unreachable'), entry(remote, 'signin')]
    render(<HubIssueBanners />)
    expect(screen.getAllByTestId('hub-issue-banner')).toHaveLength(2)
    expect(screen.getByText(/Signed out of slay\.normain\.com/)).toBeTruthy()
    expect(screen.getByText(/Can't reach This computer/)).toBeTruthy()
  })

  it('a lost sign-in offers Sign in, which opens Settings → Hubs with that sign-in started', () => {
    issues = [entry(remote, 'signin')]
    const opened = vi.fn()
    window.addEventListener('open-settings', opened)
    render(<HubIssueBanners />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe('hubs')
    expect(useHubIssueBannerStore.getState().pendingSignIn).toBe('hub:normain')
    window.removeEventListener('open-settings', opened)
  })

  it('an unreachable hub offers no Sign in, but always Hub settings and Details', () => {
    issues = [entry(remote, 'unreachable', 'WebSocket closed')]
    const opened = vi.fn()
    window.addEventListener('open-settings', opened)
    render(<HubIssueBanners />)
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Hub settings' }))
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe('hubs')
    expect(useHubIssueBannerStore.getState().pendingSignIn).toBeNull()
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
    window.removeEventListener('open-settings', opened)
  })

  it('Dismiss hides it until the cause changes', () => {
    issues = [entry(remote, 'unreachable')]
    const { rerender } = render(<HubIssueBanners />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('hub-issue-banner')).toBeNull()
    issues = [entry(remote, 'signin')]
    rerender(<HubIssueBanners />)
    expect(screen.getByTestId('hub-issue-banner')).toBeTruthy()
  })

  it('a dismissed issue that clears and comes back shows again', () => {
    issues = [entry(remote, 'unreachable')]
    const { rerender } = render(<HubIssueBanners />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    issues = []
    act(() => rerender(<HubIssueBanners />))
    issues = [entry(remote, 'unreachable')]
    rerender(<HubIssueBanners />)
    expect(screen.getByTestId('hub-issue-banner')).toBeTruthy()
  })

  it("Don't show again mutes that hub only, and persists", () => {
    issues = [entry(remote, 'unreachable'), entry(local, 'unreachable')]
    render(<HubIssueBanners />)
    // Tucked into Details: a permanent choice is not one slip away from Dismiss.
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0])
    fireEvent.click(screen.getByRole('button', { name: "Don't show again for this hub" }))
    expect(screen.getAllByTestId('hub-issue-banner')).toHaveLength(1)
    expect(useHubIssueBannerStore.getState().muted).toEqual(['hub:normain'])
    expect(localStorage.getItem('slayzone:hub-issue-banners')).toContain('hub:normain')
  })
})
