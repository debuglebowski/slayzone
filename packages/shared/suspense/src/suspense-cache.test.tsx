// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { Suspense } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { createSuspenseCache } from './suspense-cache'

afterEach(cleanup)

describe('createSuspenseCache', () => {
  it('suspends then renders resolved data', async () => {
    const cache = createSuspenseCache({
      greeting: () => Promise.resolve('hello')
    })

    function Inner() {
      const data = cache.useData('greeting')
      return <div data-testid="result">{data}</div>
    }

    await act(async () => {
      render(
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <Inner />
        </Suspense>
      )
    })

    expect(screen.getByTestId('result').textContent).toBe('hello')
  })

  it('deduplicates same-key fetches', async () => {
    const fetcher = vi.fn(() => Promise.resolve('x'))
    const cache = createSuspenseCache({ test: fetcher })

    function Inner() {
      const data = cache.useData('test')
      return <div data-testid="ok">{data}</div>
    }

    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <Inner />
        </Suspense>
      )
    })

    expect(screen.getByTestId('ok')).toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('returns primed data without fetching', async () => {
    const fetcher = vi.fn(() => Promise.resolve('from-fetch'))
    const cache = createSuspenseCache({ item: fetcher })
    cache.prime('item', ['a'], 'primed')

    function Inner() {
      const data = cache.useData('item', 'a')
      return <div data-testid="result">{data}</div>
    }

    await act(async () => {
      render(
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <Inner />
        </Suspense>
      )
    })

    expect(screen.getByTestId('result').textContent).toBe('primed')
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('caches separately by args', async () => {
    const fetcher = vi.fn((id: string) => Promise.resolve(id))
    const cache = createSuspenseCache({ item: fetcher })

    function Inner({ id }: { id: string }) {
      const data = cache.useData('item', id)
      return <div data-testid="result">{data}</div>
    }

    const { rerender } = await act(async () =>
      render(
        <Suspense fallback={<div>loading</div>}>
          <Inner id="a" />
        </Suspense>
      )
    )

    expect(screen.getByTestId('result').textContent).toBe('a')

    await act(async () => {
      rerender(
        <Suspense fallback={<div>loading</div>}>
          <Inner id="b" />
        </Suspense>
      )
    })

    expect(screen.getByTestId('result').textContent).toBe('b')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidateAll triggers re-fetch', async () => {
    let callCount = 0
    const cache = createSuspenseCache({
      counter: () => Promise.resolve(++callCount)
    })

    function Inner() {
      const data = cache.useData('counter')
      return <div data-testid="result">{data}</div>
    }

    await act(async () => {
      render(
        <Suspense fallback={<div data-testid="fallback">loading</div>}>
          <Inner />
        </Suspense>
      )
    })

    expect(screen.getByTestId('result').textContent).toBe('1')

    // Invalidate — should re-fetch and re-render
    await act(async () => {
      cache.invalidateAll('counter')
    })

    expect(screen.getByTestId('result').textContent).toBe('2')
    expect(callCount).toBe(2)
  })

  it('invalidate with specific args only clears that entry', async () => {
    const fetcher = vi.fn((id: string) => Promise.resolve(id))
    const cache = createSuspenseCache({ item: fetcher })

    function Inner() {
      const a = cache.useData('item', 'a')
      const b = cache.useData('item', 'b')
      return (
        <div data-testid="result">
          {a},{b}
        </div>
      )
    }

    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <Inner />
        </Suspense>
      )
    })

    expect(screen.getByTestId('result').textContent).toBe('a,b')
    expect(fetcher).toHaveBeenCalledTimes(2)

    // Invalidate only 'a'
    await act(async () => {
      cache.invalidate('item', 'a')
    })

    expect(screen.getByTestId('result').textContent).toBe('a,b')
    // 'a' re-fetched, 'b' was not
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher).toHaveBeenLastCalledWith('a')
  })

  it('evict removes entry without triggering re-render', async () => {
    const renderCount = vi.fn()
    const cache = createSuspenseCache({
      test: () => Promise.resolve('data')
    })

    function Inner() {
      const data = cache.useData('test')
      renderCount()
      return <div data-testid="result">{data}</div>
    }

    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <Inner />
        </Suspense>
      )
    })

    const countAfterMount = renderCount.mock.calls.length

    // Evict should NOT trigger re-render (no notify)
    cache.evict('test')
    await new Promise((r) => setTimeout(r, 50))

    expect(renderCount).toHaveBeenCalledTimes(countAfterMount)
  })

  it('handles rejection — error propagates through error boundary', async () => {
    const cache = createSuspenseCache({
      failing: () => Promise.reject(new Error('fetch failed'))
    })

    function Inner() {
      const data = cache.useData('failing')
      return <div>{data}</div>
    }

    class ErrorBoundary extends React.Component<
      { children: React.ReactNode },
      { error: string | null }
    > {
      state = { error: null as string | null }
      static getDerivedStateFromError(e: Error) {
        return { error: e.message }
      }
      render() {
        if (this.state.error) return <div data-testid="error">{this.state.error}</div>
        return this.props.children
      }
    }

    // Suppress React error boundary console noise
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      render(
        <ErrorBoundary>
          <Suspense fallback={<div>loading</div>}>
            <Inner />
          </Suspense>
        </ErrorBoundary>
      )
    })
    spy.mockRestore()

    expect(screen.getByTestId('error').textContent).toBe('fetch failed')
  })

  it('invalidate clears failed entry — retry fetches fresh data', async () => {
    let callCount = 0
    const cache = createSuspenseCache({
      flaky: () => {
        callCount++
        if (callCount === 1) return Promise.reject(new Error('fail'))
        return Promise.resolve('recovered')
      }
    })

    function Inner() {
      const data = cache.useData('flaky')
      return <div data-testid="result">{data}</div>
    }

    class ErrorBoundary extends React.Component<
      { children: React.ReactNode; cache: typeof cache },
      { error: string | null }
    > {
      state = { error: null as string | null }
      static getDerivedStateFromError(e: Error) {
        return { error: e.message }
      }
      render() {
        if (this.state.error) {
          return (
            <button
              data-testid="retry"
              onClick={() => {
                this.props.cache.invalidate('flaky')
                this.setState({ error: null })
              }}
            >
              {this.state.error}
            </button>
          )
        }
        return this.props.children
      }
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // First render — fails, error boundary catches
    await act(async () => {
      render(
        <ErrorBoundary cache={cache}>
          <Suspense fallback={<div>loading</div>}>
            <Inner />
          </Suspense>
        </ErrorBoundary>
      )
    })
    expect(screen.getByTestId('retry').textContent).toBe('fail')
    expect(callCount).toBe(1)

    // Retry — invalidate clears failed entry, error boundary resets, fresh fetch succeeds
    await act(async () => {
      screen.getByTestId('retry').click()
    })

    spy.mockRestore()
    expect(screen.getByTestId('result').textContent).toBe('recovered')
    expect(callCount).toBe(2)
  })
})
