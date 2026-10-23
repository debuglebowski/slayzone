/**
 * The first user of a standalone hub, provisioned without anyone typing anything.
 *
 * Client auth is now required on every non-supervised hub (see `server.ts`), which
 * would otherwise mean `slay hub start` on a clean root comes up and immediately
 * refuses every request from the machine that just started it. That is not a
 * security property, it is a locked door with the key inside.
 *
 * The framing that makes this coherent rather than a backdoor: a computer install
 * is one per OS user under `$HOME`, so "the OS user who owns this `$HOME`" already
 * IS an identity — the one the filesystem enforces. The bootstrap owner is just
 * that identity's projection into the hub's user table. Anyone who can read
 * `<dataRoot>/hub.owner.json` can already read the SQLite file next to it.
 *
 * Runs ONLY when the hub enforces auth and is not supervised, and only when no
 * non-service user exists — it never re-provisions, so a hub whose owner was
 * deliberately disabled does not silently regrow one. The owner is created `admin`.
 * Never with password sign-in off (T-10: there would be a password nobody can use,
 * written to a file and the log) or Entra sign-in on (O-4: an admin not from Entra) —
 * `server.ts` skips it, and `createHubUser` refuses an account with a password anyway.
 *
 * ON A HUB OTHER MACHINES CAN REACH (B13) nothing is written and nothing secret is
 * logged (T-11): the owner's password derives from `SLAYZONE_HUB_AUTH_SECRET`
 * (`@slayzone/platform/hub-auth-secret`), which the operator already holds, and the log
 * line only says how to get it (`slay hub owner-password`). There is no owner bearer
 * on that box either: `slay` there signs in like any other client (`slay hub login`).
 *
 * @module hub/bootstrap-owner
 */

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHubUser, listHubUsers, type HubAuth } from '@slayzone/hub-auth/server'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import {
  BOOTSTRAP_OWNER_EMAIL,
  ownerFilePath,
  readBootstrapOwner,
  type BootstrapOwnerFile
} from '@slayzone/platform/hub-owner-file'
import { HUB_ADDRESS_ENV } from '@slayzone/platform/hub-switches'

// Re-exported for existing consumers of this module (tests, install-handshake) —
// the schema and reader now live in `@slayzone/platform/hub-owner-file` so the
// CLI can read the SAME file without depending on this app package. See that
// module's docstring for why.
export { ownerFilePath, readBootstrapOwner, type BootstrapOwnerFile }

/**
 * Write `value` as JSON to `target`, 0600, atomically (tmp + rename). For a file that
 * holds a credential — this one.
 */
export async function writePrivateJsonFile(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    await rename(tmp, target)
    // rename preserves the tmp file's mode, but be explicit — this file holds a
    // password and must never widen if the umask or the write path changes.
    await chmod(target, 0o600)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

function writeOwnerFile(dataRoot: string, file: BootstrapOwnerFile): Promise<void> {
  return writePrivateJsonFile(ownerFilePath(dataRoot), file)
}

/**
 * Ensure this standalone hub has an owner, creating one on first boot.
 *
 * `opts.derivePasswordFrom` is the auth secret of a hub other machines can reach: the
 * owner's password derives from it and no file is written (see the module note). Set
 * but empty throws: such a hub never falls back to the file.
 * Without it (a hub only this machine reaches) the password is generated, written to
 * the 0600 owner file with a bearer, and logged once.
 *
 * Returns the owner it created, or null when one already existed (nothing was
 * written or logged) — credentials are announced exactly once.
 */
export async function ensureBootstrapOwner(
  auth: HubAuth,
  dataRoot: string,
  log: (message: string) => void = () => undefined,
  opts: { derivePasswordFrom?: string } = {}
): Promise<{ userId: string; email: string } | null> {
  const existing = await listHubUsers(auth)
  // Service accounts (the computer-transport principal) are not people and must
  // not count as "this hub already has an owner".
  const people = existing.filter((u) => !u.email.endsWith('.internal'))
  if (people.length > 0) return null

  // Present (even empty) = a reachable hub: derive, never fall back to a file. An
  // empty secret throws here, before any account exists.
  const derived = opts.derivePasswordFrom !== undefined
  // The hub's first admin (T-08).
  const created = await createHubUser(
    auth,
    { email: BOOTSTRAP_OWNER_EMAIL, name: 'Hub owner', role: 'admin' },
    derived ? { password: deriveBootstrapOwnerPassword(opts.derivePasswordFrom ?? '') } : {}
  )
  if ('error' in created) {
    // Raced with something else creating the same address. Not fatal: the hub has
    // an owner either way, which is the only postcondition that matters.
    log('[slayzone] hub owner already present — skipping bootstrap')
    return null
  }

  if (derived) {
    // Where, never what: no password, no file.
    log(
      `[slayzone] This hub requires sign-in. A first admin was created: ${created.email}. ` +
        `Its password derives from ${HUB_ADDRESS_ENV.authSecret} and is written nowhere; ` +
        `with that variable set, \`slay hub owner-password | slay hub login <hub url> ` +
        `--email ${created.email}\` signs in as it.`
    )
    return { userId: created.id, email: created.email }
  }

  // Sign in immediately so the file carries a usable bearer, not just credentials
  // a caller would have to exchange itself.
  let token: string | undefined
  try {
    const signedIn = await auth.api.signInEmail({
      body: { email: created.email, password: created.password }
    })
    token = (signedIn as { token?: string })?.token
  } catch {
    /* the password in the file is still enough to sign in later */
  }

  const file: BootstrapOwnerFile = {
    userId: created.id,
    email: created.email,
    password: created.password,
    ...(token ? { token } : {}),
    createdAt: Date.now()
  }
  await writeOwnerFile(dataRoot, file)

  // Printed ONCE, like `slay hub users add`, so an operator can sign in from
  // another machine. After this it lives only in the 0600 file.
  log(
    `\n[slayzone] This hub now requires sign-in. A first user was created for you:\n` +
      `  email:    ${file.email}\n` +
      `  password: ${file.password}\n` +
      `Stored at ${ownerFilePath(dataRoot)} (0600). \`slay\` reads it automatically on this box.\n`
  )
  return { userId: file.userId, email: file.email }
}
