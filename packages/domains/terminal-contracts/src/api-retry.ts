/**
 * Words for an API retry (`ApiRetryEvent`): why the request failed. Claude
 * Code sends a category (`error`) and the HTTP status (`errorStatus`, null when
 * no response came back); the category alone ("unknown") says nothing.
 */
export function apiRetryReason(error: string, errorStatus?: number | null): string {
  const status = typeof errorStatus === 'number' ? ` (${errorStatus})` : ''
  switch (error) {
    case 'rate_limit':
      return `rate limited${status}`
    case 'overloaded':
      return `API overloaded${status}`
    case 'server_error':
      return `server error${status}`
    case 'authentication_failed':
      return `authentication failed${status}`
    case 'billing_error':
      return `billing error${status}`
    case 'invalid_request':
      return `invalid request${status}`
    case 'unknown':
    case '':
      // null = the request got no response; absent = an event saved before
      // the status was kept (nothing more is known).
      if (errorStatus === null) return 'no response from API'
      return typeof errorStatus === 'number' ? `HTTP ${errorStatus}` : 'unknown error'
    default:
      return `${error.replace(/_/g, ' ')}${status}`
  }
}

/** `5s`, `1m 4s`: a whole-second span. */
export function formatRetrySpan(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}
