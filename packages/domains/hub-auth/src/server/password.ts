import type { HubPasswordEvent } from '@slayzone/platform/hub-switch-refusal'

/**
 * The password switch (`SLAYZONE_HUB_ENABLE_PASSWORD`, T-10) as hub-auth sees it.
 *
 * Off: better-auth's email + password is disabled (`emailAndPassword.enabled`, which
 * also refuses an in-process `auth.api.signInEmail`), every endpoint below is in its
 * `disabledPaths` (404 before any handler runs), and {@link createHubUser} refuses to
 * mint an account with a generated password. The hub's REST gate refuses the same
 * paths with a stable 403 before they reach better-auth at all (`rest-auth.ts`); this
 * is the layer under it. Password credentials already in the database are kept — they
 * cannot be used while the switch is off, and work again when it is on.
 *
 * @module hub-auth/password
 */

/**
 * Every better-auth endpoint that takes, checks, sets or resets a password, by its
 * path under better-auth's `/api/auth` base, with the audit event a refusal writes.
 * better-auth 1.6.23; `setPassword` has no HTTP route (server-only) and nothing here
 * calls it. Re-check on upgrade: a new password route that is not listed here stays
 * reachable on a password-off hub only behind a bearer, and still fails inside
 * better-auth while `emailAndPassword.enabled` is false only if it checks that flag.
 */
export const PASSWORD_AUTH_ENDPOINTS: Readonly<Record<string, HubPasswordEvent>> = {
  '/sign-in/email': 'auth.signin',
  '/sign-up/email': 'user.create',
  '/verify-password': 'auth.signin',
  '/change-password': 'auth.password.change',
  '/reset-password': 'auth.password.change',
  '/request-password-reset': 'auth.password.change'
}

/** Whether `auth` was built with password sign-in on (`HubAuthConfig.enablePassword`). */
export function isPasswordSignInEnabled(auth: {
  options: { emailAndPassword?: { enabled?: boolean } }
}): boolean {
  return auth.options.emailAndPassword?.enabled === true
}
