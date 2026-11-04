import { Component, type ReactNode } from 'react'
import { Button } from '@slayzone/ui'
import { getTrpcClient } from '../trpc'
import { getDiagnosticsContext } from '@/lib/diagnosticsClient'

/**
 * Waits before each automatic retry of an `autoRetry` error: the n-th retry waits
 * the n-th entry, every retry after the last waits the last. Never gives up — the
 * errors this is for (a hub too busy to answer in time) clear on their own.
 */
export const AUTO_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onReset?: () => void
  /**
   * Errors that are transient by nature (e.g. a load that timed out because the
   * hub was busy). For these the boundary says it is still working on it and
   * resets itself on a backoff (AUTO_RETRY_DELAYS_MS) instead of showing the
   * dead-end error screen; "Retry now" skips the wait. Any other error gets the
   * normal screen.
   */
  autoRetry?: (error: Error) => boolean
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  /** Automatic retries so far; picks the next backoff delay. */
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    void getTrpcClient().diagnostics.recordClientError.mutate({
      type: 'error-boundary',
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null,
      snapshot: getDiagnosticsContext()
    })
    if (this.isAutoRetry(error)) this.scheduleRetry()
  }

  componentWillUnmount(): void {
    this.clearRetry()
  }

  private isAutoRetry(error: Error | null): boolean {
    return !!error && !!this.props.autoRetry?.(error)
  }

  private scheduleRetry(): void {
    this.clearRetry()
    const delay = AUTO_RETRY_DELAYS_MS[Math.min(this.retries, AUTO_RETRY_DELAYS_MS.length - 1)]
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retries++
      this.reset()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private reset(): void {
    this.setState({ hasError: false, error: null })
    this.props.onReset?.()
  }

  /** A person asked: retry at once, and start the backoff over. */
  handleReset = (): void => {
    this.clearRetry()
    this.retries = 0
    this.reset()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.isAutoRetry(this.state.error)) {
        return (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center">
            <h2 className="text-lg font-semibold mb-2">Still loading</h2>
            <p className="text-sm text-muted-foreground mb-4 max-w-md">
              This is taking longer than usual. Retrying automatically…
            </p>
            <Button onClick={this.handleReset} variant="outline" size="sm">
              Retry now
            </Button>
          </div>
        )
      }

      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex flex-col items-center justify-center h-full p-6 text-center">
          <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <Button onClick={this.handleReset} variant="outline" size="sm">
            Try again
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
