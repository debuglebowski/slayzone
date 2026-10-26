import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { usePresence } from './use-presence'
import { DevServerToast } from './DevServerToast'
import { UpdateToast } from './UpdateToast'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('usePresence', () => {
  it('starts mounted only when active', () => {
    expect(renderHook(() => usePresence(false)).result.current).toEqual({
      mounted: false,
      state: 'closed'
    })
    expect(renderHook(() => usePresence(true)).result.current).toEqual({
      mounted: true,
      state: 'open'
    })
  })

  it('mounts on activate and stays mounted through the exit delay', () => {
    const { result, rerender } = renderHook(({ active }) => usePresence(active), {
      initialProps: { active: false }
    })
    rerender({ active: true })
    expect(result.current).toEqual({ mounted: true, state: 'open' })

    rerender({ active: false })
    expect(result.current).toEqual({ mounted: true, state: 'closed' })
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(result.current.mounted).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toEqual({ mounted: false, state: 'closed' })
  })

  it('re-activating during the exit cancels the unmount', () => {
    const { result, rerender } = renderHook(({ active }) => usePresence(active, 100), {
      initialProps: { active: true }
    })
    rerender({ active: false })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    rerender({ active: true })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current).toEqual({ mounted: true, state: 'open' })
  })
})

describe('DevServerToast', () => {
  const noop = (): void => {}

  it('shows the url, keeps it through the exit animation, then unmounts', () => {
    const { rerender } = render(<DevServerToast url={null} onOpen={noop} onDismiss={noop} />)
    expect(screen.queryByTestId('dev-server-toast')).toBeNull()

    rerender(<DevServerToast url="http://localhost:3000" onOpen={noop} onDismiss={noop} />)
    expect(screen.getByTestId('dev-server-toast').dataset.state).toBe('open')
    expect(screen.getByText('http://localhost:3000')).toBeTruthy()

    rerender(<DevServerToast url="http://localhost:5173" onOpen={noop} onDismiss={noop} />)
    expect(screen.getByText('http://localhost:5173')).toBeTruthy()

    rerender(<DevServerToast url={null} onOpen={noop} onDismiss={noop} />)
    expect(screen.getByTestId('dev-server-toast').dataset.state).toBe('closed')
    expect(screen.getByText('http://localhost:5173')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByTestId('dev-server-toast')).toBeNull()
  })
})

describe('UpdateToast', () => {
  const noop = (): void => {}

  it('keeps the last version text while closing', () => {
    const { container, rerender } = render(
      <UpdateToast version={null} onRestart={noop} onDismiss={noop} />
    )
    expect(container.firstChild).toBeNull()

    rerender(<UpdateToast version="1.2.3" onRestart={noop} onDismiss={noop} />)
    expect(screen.getByText('v1.2.3')).toBeTruthy()

    rerender(<UpdateToast version={null} onRestart={noop} onDismiss={noop} />)
    expect(screen.getByText('v1.2.3')).toBeTruthy()

    rerender(<UpdateToast version="1.2.4" onRestart={noop} onDismiss={noop} />)
    expect(screen.getByText('v1.2.4')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('v1.2.4')).toBeTruthy()
  })
})
