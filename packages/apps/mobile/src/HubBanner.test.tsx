import { render, screen, userEvent } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { HubBanner } from './HubBanner'
import { homeHub } from './hubs/testing'
import { watchAlerts } from './ui-kit/testing-confirm'

const unreachable = { kind: 'unreachable', hub: homeHub, detail: 'WebSocket closed' } as const
const flat = (style: unknown) => StyleSheet.flatten(style as never) ?? {}

describe('HubBanner', () => {
  it('names the hub on its buttons for VoiceOver', async () => {
    await render(<HubBanner problem={unreachable} onRetry={jest.fn()} onSignOut={jest.fn()} />)
    expect(screen.getByRole('button', { name: `Retry ${homeHub.label}` })).toBeOnTheScreen()
    expect(screen.getByRole('button', { name: `Sign out of ${homeHub.label}` })).toBeOnTheScreen()
  })

  it('retries at once, but signs out only once the user confirms', async () => {
    const onRetry = jest.fn()
    const onSignOut = jest.fn()
    const alerts = watchAlerts()
    await render(<HubBanner problem={unreachable} onRetry={onRetry} onSignOut={onSignOut} />)
    const user = userEvent.setup()
    await user.press(screen.getByText('Retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(alerts.alerts).toHaveLength(0)

    await user.press(screen.getByText('Sign out'))
    expect(onSignOut).not.toHaveBeenCalled()
    expect(alerts.alerts[0]?.title).toBe(`Sign out of ${homeHub.label}?`)
    alerts.press(`Sign out of ${homeHub.label}`)
    expect(onSignOut).toHaveBeenCalledTimes(1)
    alerts.restore()
  })

  it('sets Sign out apart from Retry, and both are finger-sized', async () => {
    await render(<HubBanner problem={unreachable} onRetry={jest.fn()} onSignOut={jest.fn()} />)
    const retry = flat(screen.getByText('Retry').props.style)
    const signOut = flat(screen.getByText('Sign out').props.style)
    expect(signOut.color).not.toBe(retry.color)
    for (const name of [`Retry ${homeHub.label}`, `Sign out of ${homeHub.label}`]) {
      expect(flat(screen.getByRole('button', { name }).props.style).minHeight).toBe(44)
    }
  })
})
