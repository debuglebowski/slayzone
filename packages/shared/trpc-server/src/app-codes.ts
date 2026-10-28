/**
 * Domain refusal codes on the wire. The error formatter in `trpc.ts` copies a stable
 * code from an error's `cause` to the client as `data.appCode`. The codes this
 * package knows (hub switch, `ADMIN_ONLY`, unsafe path) are built in; a domain's own
 * refusal error registers an extractor here, from the module that defines the error
 * — so it is registered whenever that error can be thrown, and this package never
 * imports the domain.
 *
 * @module trpc-server/app-codes
 */

/** The stable code `cause` carries, or undefined when it is not this extractor's error. */
export type AppCodeOf = (cause: unknown) => string | undefined

const extractors: AppCodeOf[] = []

/** Register an extractor. Applied after the built-in codes, in registration order. */
export function registerAppCode(extract: AppCodeOf): void {
  if (!extractors.includes(extract)) extractors.push(extract)
}

/** `{ appCode }` for every registered extractor that recognises `cause` (last wins). */
export function registeredAppCodes(cause: unknown): { appCode?: string } {
  let out: { appCode?: string } = {}
  for (const extract of extractors) {
    const code = extract(cause)
    if (code !== undefined) out = { appCode: code }
  }
  return out
}
