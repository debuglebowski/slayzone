function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

/**
 * Under a diff read by its first page only (a file whose patch is over the page
 * budget, FU1 S5): how much is left, loaded on request. Nothing without a rest.
 */
export function DiffRestButton({
  rest,
  onLoad
}: {
  rest: { remainingBytes: number; loading: boolean; failed: boolean } | null
  onLoad: () => void
}) {
  if (!rest) return null
  const size = formatBytes(rest.remainingBytes)
  return (
    <div className="flex justify-center p-3 border-t border-border">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
        disabled={rest.loading}
        onClick={onLoad}
      >
        {rest.loading
          ? `Loading rest of diff (${size})…`
          : rest.failed
            ? 'Could not load the rest of the diff. Retry'
            : `Load rest of diff (${size})`}
      </button>
    </div>
  )
}
