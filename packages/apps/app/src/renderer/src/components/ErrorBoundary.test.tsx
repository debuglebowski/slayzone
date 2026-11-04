// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'

vi.mock('@slayzone/ui', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  )
}))

const recordClientError = vi.fn()
vi.mock('@/trpc', () => ({
  getTrpcClient: () => ({
    diagnostics: { recordClientError: { mutate: recordClientError } }
  })
}))

vi.mock('@/lib/diagnosticsClient', () => ({
  getDiagnosticsContext: () => ({})
}))

const { ErrorBoundary, AUTO_RETRY_DELAYS_MS } = await import('./ErrorBoundary')

/** Advance fake time and flush the React work the fired timers caused. */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

function Bomb(): never {
  throw new Error('boom')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>content</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('content')).toBeTruthy()
  })

  it('catches a thrown error and shows the fallback UI', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
    expect(recordClientError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error-boundary', message: 'boom' })
    )
  })

  it('renders a caller-supplied fallback instead of the default UI', () => {
    render(
      <ErrorBoundary fallback={<div>custom fallback</div>}>
        <Bomb />
      </ErrorBoundary>
    )
    expect(screen.getByText('custom fallback')).toBeTruthy()
    expect(screen.queryByText('Something went wrong')).toBeNull()
  })

  it('"Try again" calls onReset and clears the error state', () => {
    const onReset = vi.fn()
    let shouldThrow = true
    function Flaky(): React.JSX.Element {
      if (shouldThrow) throw new Error('boom')
      return <div>recovered</div>
    }

    render(
      <ErrorBoundary onReset={onReset}>
        <Flaky />
      </ErrorBoundary>
    )
    expect(screen.getByText('Something went wrong')).toBeTruthy()

    shouldThrow = false
    fireEvent.click(screen.getByText('Try again'))

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(screen.getByText('recovered')).toBeTruthy()
  })

  describe('autoRetry', () => {
    class Busy extends Error {
      override name = 'Busy'
    }
    const isBusy = (e: Error) => e.name === 'Busy'

    it('a matching error shows a retrying state and resets on its own, with backoff', async () => {
      vi.useFakeTimers()
      const onReset = vi.fn()
      // React re-renders a throwing tree more than once, so the switch is
      // explicit rather than a count of renders.
      let busy = true
      function Slow(): React.JSX.Element {
        if (busy) throw new Busy('timed out')
        return <div>recovered</div>
      }
      render(
        <ErrorBoundary onReset={onReset} autoRetry={isBusy}>
          <Slow />
        </ErrorBoundary>
      )
      // Not the dead-end screen: it says it is still working on it.
      expect(screen.queryByText('Something went wrong')).toBeNull()
      expect(screen.getByText(/taking longer than usual/i)).toBeTruthy()

      await advance(AUTO_RETRY_DELAYS_MS[0] - 1)
      expect(onReset).not.toHaveBeenCalled()
      await advance(1)
      expect(onReset).toHaveBeenCalledTimes(1)
      // Second failure waits the next, longer delay.
      expect(screen.getByText(/taking longer than usual/i)).toBeTruthy()
      busy = false
      await advance(AUTO_RETRY_DELAYS_MS[1] - 1)
      expect(onReset).toHaveBeenCalledTimes(1)
      await advance(1)
      expect(onReset).toHaveBeenCalledTimes(2)
      expect(screen.getByText('recovered')).toBeTruthy()
    })

    it('"Retry now" skips the wait', () => {
      vi.useFakeTimers()
      const onReset = vi.fn()
      let throws = true
      function Slow(): React.JSX.Element {
        if (throws) throw new Busy('timed out')
        return <div>recovered</div>
      }
      render(
        <ErrorBoundary onReset={onReset} autoRetry={isBusy}>
          <Slow />
        </ErrorBoundary>
      )
      throws = false
      fireEvent.click(screen.getByText('Retry now'))
      expect(onReset).toHaveBeenCalledTimes(1)
      expect(screen.getByText('recovered')).toBeTruthy()
    })

    it('keeps retrying at the longest delay, never giving up', async () => {
      vi.useFakeTimers()
      const onReset = vi.fn()
      function Slow(): never {
        throw new Busy('timed out')
      }
      render(
        <ErrorBoundary onReset={onReset} autoRetry={isBusy}>
          <Slow />
        </ErrorBoundary>
      )
      // One act per retry: each retry's re-render (which arms the next one) is
      // flushed when its act ends.
      const last = AUTO_RETRY_DELAYS_MS[AUTO_RETRY_DELAYS_MS.length - 1]
      for (const delay of [...AUTO_RETRY_DELAYS_MS, last, last]) await advance(delay)
      expect(onReset).toHaveBeenCalledTimes(AUTO_RETRY_DELAYS_MS.length + 2)
      expect(screen.getByText(/taking longer than usual/i)).toBeTruthy()
    })

    it('a non-matching error still gets the normal error screen, no retry', async () => {
      vi.useFakeTimers()
      const onReset = vi.fn()
      render(
        <ErrorBoundary onReset={onReset} autoRetry={isBusy}>
          <Bomb />
        </ErrorBoundary>
      )
      expect(screen.getByText('Something went wrong')).toBeTruthy()
      await advance(AUTO_RETRY_DELAYS_MS[AUTO_RETRY_DELAYS_MS.length - 1] * 3)
      expect(onReset).not.toHaveBeenCalled()
    })

    it('stops retrying once unmounted', async () => {
      vi.useFakeTimers()
      const onReset = vi.fn()
      function Slow(): never {
        throw new Busy('timed out')
      }
      const { unmount } = render(
        <ErrorBoundary onReset={onReset} autoRetry={isBusy}>
          <Slow />
        </ErrorBoundary>
      )
      unmount()
      await advance(AUTO_RETRY_DELAYS_MS[0] * 2)
      expect(onReset).not.toHaveBeenCalled()
    })
  })
})
