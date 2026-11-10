import { useState } from 'react'
import { Button } from '@slayzone/ui'

/**
 * Why the terminal could not start. A start refused because a chat of the task
 * runs the conversation (`conversation-in-use`) offers "Continue here": the
 * chat stops first, then the terminal starts on that conversation. One refused
 * because ANOTHER terminal tab runs this tab's session
 * (`conversation-in-other-tab`, the message names the tab) offers "Start new
 * session" — never automatically: a silent fresh start is how a tab loses its
 * session.
 */
export function TerminalStartError({
  message,
  code,
  onContinueHere,
  onStartFresh
}: {
  message: string
  code: string | null
  /** The hand-off; absent where this tab cannot take the conversation over. */
  onContinueHere?: () => Promise<void>
  /** Reset this tab's session and start a new one; absent where unsupported. */
  onStartFresh?: () => void
}) {
  const canStartFresh = code === 'conversation-in-other-tab' && onStartFresh !== undefined
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const canContinue = code === 'conversation-in-use' && onContinueHere !== undefined

  const continueHere = (): void => {
    if (!onContinueHere || pending) return
    setPending(true)
    setFailed(null)
    onContinueHere()
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .then(() => setPending(false))
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background dark:bg-surface-0 z-10 p-4">
      <div
        data-testid="terminal-start-error"
        className="flex max-w-md flex-col items-center gap-3 text-center"
      >
        <div className="text-destructive text-sm">Failed to start terminal: {message}</div>
        {canContinue && (
          <Button
            size="sm"
            data-testid="terminal-continue-here"
            disabled={pending}
            onClick={continueHere}
          >
            {pending ? 'Continuing…' : 'Continue here'}
          </Button>
        )}
        {canStartFresh && (
          <Button
            size="sm"
            variant="outline"
            data-testid="terminal-start-new-session"
            onClick={onStartFresh}
          >
            Start new session
          </Button>
        )}
        {failed && (
          <div className="text-xs text-muted-foreground">Couldn&apos;t continue here: {failed}</div>
        )}
      </div>
    </div>
  )
}
