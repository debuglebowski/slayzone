/**
 * A new id for a message this client sends (the hub's outbox and the CLI key on it,
 * so a resend under the same id is the same message). A UUID v4: the platform's
 * `crypto.randomUUID` where there is one, else built from `Math.random` — an
 * idempotency key, not a secret.
 */
export function newMessageId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const variant = ((Math.floor(Math.random() * 4) + 8) as number).toString(16)
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`
}
