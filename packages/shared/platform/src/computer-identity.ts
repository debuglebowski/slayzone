/**
 * Computer identity constants — a LEAF module with no imports at all.
 *
 * Why it is its own file rather than a section of `slayzone-config.ts`: that
 * module reaches for `node:fs` / `node:path` to resolve ROOT, which makes it
 * unimportable from renderer code (rollup externalizes the node built-ins and
 * the build fails on the first re-exported symbol). The Computers settings table
 * needs to know which row is the app's own computer, so the identity has to be
 * readable from the browser bundle as well as from the computer and the hub.
 *
 * `slayzone-config.ts` re-exports everything here, so existing importers are
 * unaffected — there is exactly one definition, three audiences.
 */

/**
 * Enroll name of the co-located computer the desktop app supervises.
 *
 * Load-bearing in two places that must NOT diverge:
 *   - the supervised computer (computer `config.ts`) defaults its enroll `name` to
 *     this when `SLAYZONE_SUPERVISED=1`, and
 *   - the sidecar composition passes it as `localComputerName` to the computer-auth
 *     adapters (which treat an enroll for THIS name as the local computer → gets a
 *     deterministic id + UPSERT + duplicate collapse).
 *
 * If those two disagree the dedup silently disables (every local enroll takes the
 * remote fresh-uuid path → an orphan per boot), so both derive this const. A
 * standalone computer renames via the config.json `computerName` key instead.
 */
export const DEFAULT_LOCAL_COMPUTER_NAME = 'local-computer'
