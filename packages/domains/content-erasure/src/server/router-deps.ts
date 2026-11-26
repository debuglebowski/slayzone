import type { AdminContentErasure } from './admin'

export type HubAccountRole = 'admin' | 'user'

/** One account (hub-auth `HubUserRow`, mirrored: this package must not depend on hub-auth). */
export interface HubAccountRow {
  id: string
  email: string
  name: string
  role: HubAccountRole
  /** ISO-8601 when disabled, else null. */
  disabledAt: string | null
  /** ISO-8601. */
  createdAt: string
  /** The break-glass account: listed, but only `slayzone-hub break-glass` manages it. */
  breakGlass: boolean
}

/**
 * The hub's account capability (`apps/hub` `createHubUsersCapability`), the same object
 * the CLI's `/api/hub/users` route uses. The tRPC `hub.users` router is the Settings
 * Users tab's way in; both reach hub-auth's users.ts through it.
 */
export interface HubAdminDeps {
  dataRoot: string
  users: {
    ready: () => boolean
    /** Who manages roles, and whether `create` can work (password sign-in on). */
    describe: () => {
      roleAuthority: 'idp' | 'entra-app-roles' | 'hub'
      passwordEnabled: boolean
    } | null
    list: () => Promise<HubAccountRow[]>
    /** The generated password is returned ONCE; only its hash is stored. */
    create: (input: { email: string; name?: string; role?: HubAccountRole }) => Promise<
      | {
          ok: true
          user: { id: string; email: string; name: string; role: HubAccountRole; password: string }
        }
      | { ok: false; reason: 'exists' | 'sso-managed' | 'idp-managed' }
    >
    disable: (
      email: string
    ) => Promise<'ok' | 'not-found' | 'protected' | 'last-user' | 'last-admin'>
    enable: (email: string) => Promise<'ok' | 'not-found' | 'protected' | 'erasure-in-progress'>
    setRole: (
      email: string,
      role: HubAccountRole
    ) => Promise<'ok' | 'not-found' | 'protected' | 'last-admin' | 'sso-managed' | 'idp-managed'>
  }
  erasure: AdminContentErasure
}
let current: HubAdminDeps | null = null
export function setHubAdminDeps(deps: HubAdminDeps | null): void {
  current = deps
}
export function getHubAdminDeps(): HubAdminDeps | null {
  return current
}
