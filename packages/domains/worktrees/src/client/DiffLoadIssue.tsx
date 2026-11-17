/**
 * Signs that a deferred diff could not be read (FU1 S5), each with a retry: a diff
 * shown from its last good read while the new one failed (outdated), and the files
 * the continuous flow cannot show at all.
 */

/** Above a diff that is its last good read: the latest one could not be loaded. */
export function DiffOutdatedBar({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex justify-center px-3 py-1.5 border-b border-border bg-muted/40">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground"
        onClick={onRetry}
      >
        Outdated: the latest diff could not be loaded. Retry
      </button>
    </div>
  )
}

/** Atop the continuous flow: files whose diff could not be loaded. Nothing when none. */
export function DiffFailedFiles({ count, onRetry }: { count: number; onRetry: () => void }) {
  if (count === 0) return null
  return (
    <div className="flex justify-center px-2 pb-2">
      <button
        type="button"
        className="text-xs text-destructive hover:text-foreground"
        onClick={onRetry}
      >
        {`Could not load ${count} ${count === 1 ? 'file' : 'files'}. Retry`}
      </button>
    </div>
  )
}

/** The continuous flow's empty state: "No changes", never while files failed to load. */
export function DiffNoChanges({ failedCount }: { failedCount: number }) {
  if (failedCount > 0) return null
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      <p className="text-xs text-muted-foreground">No changes</p>
    </div>
  )
}
