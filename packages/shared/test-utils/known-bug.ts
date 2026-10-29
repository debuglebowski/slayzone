/**
 * `expectKnownBug` — the unit-test twin of the chat e2e harness's `knownBug()`
 * (packages/apps/app/e2e/fixtures/chat.ts): mark ONE assertion as a known, still
 * open bug without masking the rest of the test.
 *
 * Unlike vitest's `it.fails`, which inverts the whole test (a broken setup then
 * "passes"), only `assertion` is inverted:
 *   - it throws (the bug is still there)  → expected, the test stays green;
 *   - it passes (the bug was fixed)        → this throws: delete the wrapper.
 * `REVEAL_KNOWN_BUGS=1` runs `assertion` plainly, to see its real failure.
 *
 * @module test-utils/known-bug
 */
export interface KnownBug {
  /** Audit problem number (`'#6'`), when the bug is from the chat audit. */
  audit?: string
  /** The plan item that fixes it (`'1.5'`). */
  fixedBy: string
  /** What is broken, in one line. */
  what: string
}

export async function expectKnownBug(bug: KnownBug, assertion: () => unknown): Promise<void> {
  if (process.env.REVEAL_KNOWN_BUGS === '1') {
    await assertion()
    return
  }
  try {
    await assertion()
  } catch {
    return
  }
  const id = bug.audit ? `audit ${bug.audit}` : 'found by P0'
  throw new Error(
    `KNOWN BUG FIXED (${id}: ${bug.what}) — plan item ${bug.fixedBy} landed; ` +
      'replace expectKnownBug() with the plain assertion.'
  )
}
