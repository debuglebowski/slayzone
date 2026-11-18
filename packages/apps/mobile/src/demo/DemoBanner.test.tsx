import { render, screen, userEvent } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { watchAlerts } from '../ui-kit/testing-confirm'
import { DemoBanner } from './DemoBanner'

const mockSessions = { demo: true, exitDemo: jest.fn() }
jest.mock('../hub-sessions', () => ({ useHubSessions: () => mockSessions }))

describe('DemoBanner', () => {
  it('leaves the demo only once the user confirms (its changes are discarded)', async () => {
    const alerts = watchAlerts()
    await render(<DemoBanner />)
    await userEvent.setup().press(screen.getByTestId('exit-demo'))
    expect(mockSessions.exitDemo).not.toHaveBeenCalled()
    expect(alerts.alerts[0]?.message).toMatch(/discarded/)
    alerts.press('Exit demo')
    expect(mockSessions.exitDemo).toHaveBeenCalledTimes(1)
    alerts.restore()
  })

  it('has a finger-sized Exit demo', async () => {
    await render(<DemoBanner />)
    const style = StyleSheet.flatten(screen.getByTestId('exit-demo').props.style)
    expect(style.minHeight).toBe(44)
  })
})
