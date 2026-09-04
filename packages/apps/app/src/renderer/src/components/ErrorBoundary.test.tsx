// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'

vi.mock('@slayzone/ui', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  )
}))

const recordClientError = vi.fn()
vi.mock('@slayzone/transport/client', () => ({
  getTrpcClient: () => ({
    diagnostics: { recordClientError: { mutate: recordClientError } }
  })
}))

vi.mock('@/lib/diagnosticsClient', () => ({
  getDiagnosticsContext: () => ({})
}))

const { ErrorBoundary } = await import('./ErrorBoundary')

function Bomb(): never {
  throw new Error('boom')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
})
