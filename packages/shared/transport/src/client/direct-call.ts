/**
 * One direct-link call with a deadline, and what its failure means
 * (docs/direct-link.md). Shared by the desktop and mobile terminals, so a keystroke
 * is handled the same way on both.
 *
 * @module transport/client/direct-call
 */

/**
 * How long a direct write or backfill may take. Past it the socket is presumed
 * half-open (no FIN, keepalive not expired yet): the caller goes to the hub instead
 * and drops the lease, so nothing waits on a dead socket.
 */
export const DIRECT_CALL_DEADLINE_MS = 3_000

export class DirectDeadlineError extends Error {
  constructor() {
    super('direct link did not answer in time')
    this.name = 'DirectDeadlineError'
  }
}

export function withDirectDeadline<T>(
  p: Promise<T>,
  ms: number = DIRECT_CALL_DEADLINE_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DirectDeadlineError()), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * Why a direct call failed:
 *  - `refused`: the grant ended (FORBIDDEN / UNAUTHORIZED). The computer did not run
 *    it: use the hub.
 *  - `transport`: the socket closed under it, or nothing answered in time. Use the
 *    hub, and drop the lease.
 *  - `answered`: the computer ran it and failed. That answer stands.
 */
export function directCallFailure(err: unknown): 'refused' | 'transport' | 'answered' {
  if (err instanceof DirectDeadlineError) return 'transport'
  const code = (err as { data?: { code?: string } } | null)?.data?.code
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return 'refused'
  return code === undefined ? 'transport' : 'answered'
}
