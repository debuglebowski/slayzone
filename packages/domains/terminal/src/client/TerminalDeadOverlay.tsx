import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import type { ValidationResult } from '@slayzone/terminal/shared'
import { stripAnsi } from './Terminal.utils'

export interface TerminalDeadOverlayProps {
  isStaleSession: boolean
  providerLabel: string
  deadCrashOutput: string | null
  deadExitCode: number | null
  /** Raw prop — gates the Retry button's visibility. */
  onRetry?: () => void
  onStartFresh: () => void
  onRetryClick: () => void
  onDoctor: () => void
  doctorLoading: boolean
  doctorResults: ValidationResult[] | null
}

// The dead-session overlay. Branches internally between the stale-session
// (issue #90: provider-named "session expired" + Start fresh) and the generic
// exit-code variant (crash preview + Retry/Doctor). The parent guards rendering
// on `showDeadOverlay`.
export function TerminalDeadOverlay({
  isStaleSession,
  providerLabel,
  deadCrashOutput,
  deadExitCode,
  onRetry,
  onStartFresh,
  onRetryClick,
  onDoctor,
  doctorLoading,
  doctorResults
}: TerminalDeadOverlayProps): React.JSX.Element {
  if (isStaleSession) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-background dark:bg-surface-0 z-10 p-6 gap-3 overflow-y-auto text-center">
        <p className="text-sm font-medium text-foreground">{providerLabel} session expired</p>
        <p className="text-sm text-muted-foreground max-w-md">
          This conversation was cleaned up — agent sessions expire over time. Your task and files
          are untouched. Start a fresh session to continue.
        </p>
        <button
          onClick={onStartFresh}
          className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Start fresh
        </button>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-background dark:bg-surface-0 z-10 p-6 gap-4 overflow-y-auto">
      {deadCrashOutput && (
        <pre className="text-xs text-muted-foreground dark:text-muted-foreground max-h-32 overflow-y-auto w-full max-w-lg bg-surface-2 dark:bg-surface-0 rounded p-3 font-mono whitespace-pre-wrap break-all">
          {stripAnsi(deadCrashOutput).split('\n').slice(-20).join('\n')}
        </pre>
      )}
      <p className="text-sm text-muted-foreground">Process exited with code {deadExitCode}</p>
      <div className="flex gap-2">
        {onRetry && (
          <button
            onClick={onRetryClick}
            className="px-3 py-1.5 text-sm rounded-md bg-surface-2 dark:bg-surface-2 hover:bg-accent dark:hover:bg-accent text-foreground dark:text-foreground transition-colors"
          >
            Retry
          </button>
        )}
        <button
          onClick={onDoctor}
          disabled={doctorLoading}
          className="px-3 py-1.5 text-sm rounded-md bg-surface-2 dark:bg-surface-2 hover:bg-accent dark:hover:bg-accent text-foreground dark:text-foreground transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {doctorLoading ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Checking…
            </>
          ) : (
            'Doctor'
          )}
        </button>
      </div>
      {doctorResults && (
        <div className="w-full max-w-sm space-y-2">
          {doctorResults.map((r) => (
            <div
              key={r.check}
              className={`rounded-lg border p-3 space-y-1.5 ${r.ok ? 'border-green-500/20 bg-green-50/40 dark:bg-green-950/20' : 'border-red-500/20 bg-red-50/40 dark:bg-red-950/20'}`}
            >
              <div className="flex items-start gap-2">
                {r.ok ? (
                  <CheckCircle2 className="size-3.5 text-green-600 dark:text-green-400 shrink-0 mt-px" />
                ) : (
                  <XCircle className="size-3.5 text-red-500 dark:text-red-400 shrink-0 mt-px" />
                )}
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-medium leading-none">{r.check}</p>
                  <p className="text-xs text-muted-foreground dark:text-muted-foreground">
                    {r.detail}
                  </p>
                </div>
              </div>
              {!r.ok && r.fix && (
                <div className="ml-5">
                  <code className="text-xs bg-surface-2 dark:bg-surface-2 text-muted-foreground dark:text-foreground rounded px-2 py-1 font-mono block">
                    {r.fix}
                  </code>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
