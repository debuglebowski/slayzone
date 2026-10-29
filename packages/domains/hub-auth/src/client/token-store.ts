/**
 * Where a client keeps the bearer each hub issued it, keyed by the client's hub id.
 * Each platform brings its own: the desktop app an encrypted file (Electron
 * `safeStorage`, apps/app `hub-tokens.ts`), a mobile app its secure storage.
 */
export interface HubTokenStore {
  /** The hub's token, or null when none is stored (or it cannot be read). */
  get: (hubId: string) => Promise<string | null>
  /** Store the hub's token, replacing any earlier one. */
  set: (hubId: string, token: string) => Promise<void>
  /** Forget the hub's token. */
  delete: (hubId: string) => Promise<void>
}
