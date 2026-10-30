// @vitest-environment jsdom
/**
 * The gate shown while Convex is not running says WHY — the one reason in force — instead
 * of listing every possible one; while the answers are still coming in it shows no
 * "unavailable" verdict at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LEADERBOARD_AUTH_DISABLED, type LeaderboardUnavailable } from './auth'
import { LeaderboardPage } from './LeaderboardPage'

function renderGate(unavailable: LeaderboardUnavailable): string {
  render(<LeaderboardPage auth={{ ...LEADERBOARD_AUTH_DISABLED, unavailable }} />)
  return document.body.textContent ?? ''
}

afterEach(() => {
  cleanup()
})

describe('LeaderboardPage gate', () => {
  it('a hub turned telemetry off: names the hub and its switch', () => {
    const text = renderGate({ kind: 'hub-telemetry-off', hubLabel: 'slay.normain.com' })
    expect(screen.getByRole('heading', { name: 'Leaderboard unavailable' })).toBeTruthy()
    expect(text).toContain('slay.normain.com')
    expect(text).toContain('SLAYZONE_HUB_ENABLE_TELEMETRY=0')
    expect(text).not.toContain('this build has none configured')
  })

  it('a hub without a label (web shell): says "this hub"', () => {
    const text = renderGate({ kind: 'hub-telemetry-off', hubLabel: null })
    expect(text).toContain('This hub')
  })

  it("the user's off tier: points at the setting, not at a hub or the build", () => {
    const text = renderGate({ kind: 'telemetry-off' })
    expect(text).toContain('You turned telemetry off')
    expect(text).not.toContain('SLAYZONE_HUB_ENABLE_TELEMETRY')
  })

  it('no deployment: says the build has none', () => {
    const text = renderGate({ kind: 'no-deployment' })
    expect(text).toContain('This build has no SlayZone cloud service configured')
  })

  it('starting: no "unavailable" verdict while the answers are still coming in', () => {
    renderGate({ kind: 'starting' })
    expect(screen.queryByRole('heading', { name: 'Leaderboard unavailable' })).toBeNull()
    expect(screen.getByTestId('leaderboard-starting')).toBeTruthy()
  })
})
