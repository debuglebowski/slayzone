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

/**
 * An account's role on a hub. Named exactly as better-auth's `admin` plugin names
 * it (`user.role`), so switching to that plugin later is a data migration only.
 * Nothing enforces it yet; the admin role never grants a read path into another
 * user's sessions.
 */
export type HubRole = 'admin' | 'user'

/** Authenticated user context resolved from a session (cookie or bearer token). */
export interface HubAuthContext {
  userId: string
  role: HubRole
  /** Active organization of the session, if any. */
  orgId: string | null
  session: HubAuthSession
}

/** Principal resolved from a computer API key. */
export interface ComputerPrincipal {
  computerId: string
  /** better-auth apikey row id — pass to `revokeComputerApiKey`. */
  keyId: string
}
