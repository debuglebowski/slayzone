import { useState } from 'react'
import { Button } from '@slayzone/ui'

/**
 * Why the terminal could not start. A start refused because a chat of the task
 * runs the conversation (`conversation-in-use`) offers "Continue here": the
 * chat stops first, then the terminal starts on that conversation.
 */
export function TerminalStartError({
  message,
  code,
  onContinueHere
}: {
  message: string
  code: string | null
  /** The hand-off; absent where this tab cannot take the conversation over. */
  onContinueHere?: () => Promise<void>
}) {
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
        {failed && (
          <div className="text-xs text-muted-foreground">Couldn&apos;t continue here: {failed}</div>
        )}
      </div>
    </div>
  )
}
