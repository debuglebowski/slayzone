import { Component, type ReactNode } from 'react'
import { Button } from '@slayzone/ui'
import { tryGetTrpcVanillaClient } from '@slayzone/transport/client'
import { getDiagnosticsContext } from '@/lib/diagnosticsClient'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    tryGetTrpcVanillaClient()?.diagnostics.recordClientError.mutate({
      type: 'error-boundary',
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null,
      snapshot: getDiagnosticsContext()
    }).catch(() => {})
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    if (this.state.hasError) {
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
