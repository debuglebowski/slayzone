export function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /\bHTTP 401\b|\bHTTP 403\b/.test(err.message)
}

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message + (err.cause instanceof Error ? err.cause.message : '')
  return (
    msg.includes('ENOTFOUND') ||
    msg.includes('CONNECT_TIMEOUT') ||
    msg.includes('fetch failed') ||
    msg.includes('ENETUNREACH')
  )
}
