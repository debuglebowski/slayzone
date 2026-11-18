import { act, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Animated } from 'react-native'
import { AgentDot } from './TaskGlyphs'

describe('AgentDot', () => {
  afterEach(() => jest.restoreAllMocks())

  it('names a finished, unread agent "Ready for review"', async () => {
    await render(<AgentDot kind="attention" />)
    expect(screen.getByLabelText('Ready for review')).toBeOnTheScreen()
  })

  it('pulses a running agent', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    const loop = jest.spyOn(Animated, 'loop')
    await render(<AgentDot kind="running" />)
    await act(async () => {})
    expect(loop).toHaveBeenCalled()
  })

  it('stays still when Reduce Motion is on', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
    const loop = jest.spyOn(Animated, 'loop')
    await render(<AgentDot kind="running" />)
    await act(async () => {})
    expect(loop).not.toHaveBeenCalled()
  })

  it('stops pulsing when Reduce Motion turns on', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    let onChange: ((on: boolean) => void) | undefined
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
      event: string,
      handler: (on: boolean) => void
    ) => {
      if (event === 'reduceMotionChanged') onChange = handler
      return { remove: () => {} }
    }) as never)
    const stop = jest.fn()
    jest.spyOn(Animated, 'loop').mockReturnValue({ start: jest.fn(), stop, reset: jest.fn() })
    await render(<AgentDot kind="running" />)
    await act(async () => {})
    await act(async () => onChange?.(true))
    expect(stop).toHaveBeenCalled()
  })
})
