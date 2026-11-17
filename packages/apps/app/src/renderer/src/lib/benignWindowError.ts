/**
 * Window `error` events that are not errors. Chromium reports a ResizeObserver
 * callback that resized an observed element in the same frame as an ErrorEvent
 * with no Error object (spec: the extra notifications are delivered next frame,
 * nothing is lost). Recorded as `renderer.window.error` they were ~300/h of noise
 * under load — and blank, since error messages are private — burying real errors.
 */
const BENIGN_MESSAGES = [
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded'
]

export function isBenignWindowError(event: { message: string; error: unknown }): boolean {
  return event.error == null && BENIGN_MESSAGES.includes(event.message)
}
