/**
 * The password switch at boot (T-10): break-glass on a hub with Entra sign-in (O-9).
 *
 *   Entra sign-in on + `SLAYZONE_HUB_ENABLE_PASSWORD=1`
 *       Break-glass is OPEN. The hub keeps one temporary password account (role `user`)
 *       and its email + password in `<ROOT>/hub.break-glass.json` (0600) — never in a
 *       log line. Created at the first such boot; a restart keeps it while it is enabled.
 *   `SLAYZONE_HUB_ENABLE_PASSWORD=0` (any hub)
 *       CLOSED. Every enabled break-glass account is disabled and its sessions revoked
 *       (both classes), and the file is deleted. Nothing to do on a hub that never
 *       opened it.
 *   Anything else (the desktop app's hub, a password hub)
 *       Nothing: no read, no write.
 *
 * The operator's whole runbook is the switch plus a restart, both on the box; each
 * step leaves an audit line (`hub.boot` from server.ts, `user.create` /
 * `user.disable` with a `break_glass` reason here, the sign-ins themselves). The
 * account functions are hub-auth's (`break-glass.ts` there, with the why); this module
 * owns the file and the web sessions in the app DB.
 *
 * @module hub/break-glass
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  closeBreakGlassAccounts,
  createBreakGlassAccount,
  type HubAuth,
  listOpenBreakGlassAccounts
} from '@slayzone/hub-auth/server'
import type { SlayzoneDb } from '@slayzone/platform'
import { HUB_SWITCH_ENV } from '@slayzone/platform/hub-switches'
import { writePrivateJsonFile } from './bootstrap-owner'
import { revokeAllWebSessions } from './web-sessions'

/** What `<ROOT>/hub.break-glass.json` holds. */
export interface BreakGlassFile {
  userId: string
  email: string
  password: string
  createdAt: number
}

export function breakGlassFilePath(dataRoot: string): string {
  return join(dataRoot, 'hub.break-glass.json')
}

async function readBreakGlassFile(dataRoot: string): Promise<BreakGlassFile | null> {
  try {
    const parsed = JSON.parse(await readFile(breakGlassFilePath(dataRoot), 'utf8')) as unknown
    const userId = (parsed as { userId?: unknown } | null)?.userId
    return typeof userId === 'string' && userId ? (parsed as BreakGlassFile) : null
  } catch {
    return null
  }
}

export type BreakGlassOutcome =
  | { state: 'none' }
  | { state: 'open'; userId: string; created: boolean }
  | { state: 'closed'; closed: string[] }

/** Apply the password switch to break-glass at boot (see the module note). */
export async function applyBreakGlassAtBoot(opts: {
  auth: HubAuth
  db: SlayzoneDb
  dataRoot: string
  enablePassword: boolean
  ssoActive: boolean
  log: (message: string) => void
}): Promise<BreakGlassOutcome> {
  const { auth, db, dataRoot, log } = opts
  const file = breakGlassFilePath(dataRoot)

  if (!opts.enablePassword) {
    const closed = await closeBreakGlassAccounts(auth, {
      revokeExternalSessions: (userId) => revokeAllWebSessions(db, userId)
    })
    await rm(file, { force: true })
    if (closed.length > 0) {
      log(`[slayzone] break-glass closed: ${closed.length} temporary account(s) disabled`)
    }
    return { state: 'closed', closed }
  }
  if (!opts.ssoActive) return { state: 'none' }

  const kept = await readBreakGlassFile(dataRoot)
  if (kept && (await listOpenBreakGlassAccounts(auth)).some((u) => u.id === kept.userId)) {
    log(`[slayzone] break-glass is open: the temporary account in ${file} is still enabled`)
    return { state: 'open', userId: kept.userId, created: false }
  }
  const created = await createBreakGlassAccount(auth)
  const record: BreakGlassFile = {
    userId: created.id,
    email: created.email,
    password: created.password,
    createdAt: Date.now()
  }
  await writePrivateJsonFile(file, record)
  // Where, never what: the password is only in the 0600 file.
  log(
    `[slayzone] break-glass is open (${HUB_SWITCH_ENV.enablePassword}=1 beside Entra ` +
      `sign-in): a temporary account was created; its email and password are in ${file} ` +
      `(0600). Set ${HUB_SWITCH_ENV.enablePassword}=0 and restart to close it.`
  )
  return { state: 'open', userId: created.id, created: true }
}
