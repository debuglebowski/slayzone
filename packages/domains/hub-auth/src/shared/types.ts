/**
 * Shared hub-auth types. Client-safe: no server or node imports.
 */

/**
 * Minimal structural subset of a better-auth session that hub consumers rely
 * on. Kept structural (not imported from better-auth) so client code can use
 * these types without pulling in the server library.
 */
export interface HubAuthSession {
  id: string
  userId: string
  token: string
  expiresAt: Date
  /** Set by the organization plugin when the session has an active organization. */
  activeOrganizationId?: string | null
}

/** Authenticated user context resolved from a session (cookie or bearer token). */
export interface HubAuthContext {
  userId: string
  /** Active organization of the session, if any. */
  orgId: string | null
  session: HubAuthSession
}

/** Principal resolved from a runner API key. */
export interface RunnerPrincipal {
  runnerId: string
  /** better-auth apikey row id — pass to `revokeRunnerApiKey`. */
  keyId: string
}
