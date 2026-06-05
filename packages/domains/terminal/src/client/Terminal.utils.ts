// Strip trailing whitespace from each line of selection text.
// xterm's getTrimmedLength treats rendered spaces (e.g. from padded UI like
// lazygit, fzf, tables) as real content, so copies include them. Pasting
// that into a narrower terminal wraps → phantom line breaks.
export const trimSelectionTrailingSpaces = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')

export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
}

// Wait for container to have non-zero dimensions before opening terminal
export function waitForDimensions(
  container: HTMLElement,
  signal: AbortSignal,
  timeoutMs = 3000
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Already has dimensions? Resolve immediately
    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      resolve()
      return
    }

    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      observer.disconnect()
      signal.removeEventListener('abort', onAbort)
    }

    // Timeout to prevent hanging forever
    const timeoutId = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    // Otherwise wait for ResizeObserver
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        cleanup()
        resolve()
      }
    })

    // Handle abort (component unmount)
    const onAbort = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort)

    observer.observe(container)
  })
}
