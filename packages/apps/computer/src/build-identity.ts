declare const __SLAYZONE_COMPUTER_BUILD_ID__: string | undefined

/** Captured in loaded code: rebuilding a same-version development bundle must
 * not make an old in-memory host appear current just because its path matches.
 */
export const COMPUTER_BUILD_ID =
  typeof __SLAYZONE_COMPUTER_BUILD_ID__ === 'string' ? __SLAYZONE_COMPUTER_BUILD_ID__ : undefined
