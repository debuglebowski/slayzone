import { forEachIsolated } from '@slayzone/platform/isolation'

/**
 * Per-item isolation for the hub's per-computer passes (recovery, lifecycle
 * delivery, metadata, folder deletions). One conversation or task whose state
 * the hub cannot apply must fail on its own: a pass that aborts on its first bad
 * item makes EVERY chat and agent on the computer unusable, for a problem in one.
 *
 * Only a computer that cannot be reached fails the whole pass: then no item can
 * succeed, and continuing would wait out one timeout per item.
 */

/**
 * Transport failures: the computer is offline, closed the link, timed out, or
 * runs a version that cannot answer (computer-transport's error classes, matched
 * by name: this package does not depend on the transport).
 */
const UNREACHABLE = new Set([
  'RpcTimeoutError',
  'RpcDisposedError',
  'NoComputerAvailableError',
  'ComputerUpdatePendingError'
])
/** `ComputerTransportErrorCodes.unknownComputer` (frames.ts): not connected. */
const NOT_CONNECTED = -32004

export function isComputerUnreachable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (UNREACHABLE.has(error.name) ||
      (error.name === 'RpcError' && (error as { code?: unknown }).code === NOT_CONNECTED))
  )
}

/**
 * Runs one item of a pass. A failure is reported to `onFailure` (and logged) and
 * the pass continues; an unreachable computer still fails the pass. Returns
 * whether the item succeeded. The hub's wrapper over `forEachIsolated`
 * (@slayzone/platform/isolation), the one isolation primitive.
 */
export async function isolateItem(
  label: string,
  run: () => Promise<unknown>,
  onFailure?: (error: Error) => void
): Promise<boolean> {
  const report = await forEachIsolated(
    [label],
    {
      pass: 'chat',
      key: (item) => item,
      isFatal: isComputerUnreachable,
      log: (_message, error) =>
        console.error(`[chat] ${label} failed; continuing with the other items:`, error)
    },
    run
  )
  const failure = report.failed[0]
  if (failure) onFailure?.(failure.error)
  return report.ok === 1
}
