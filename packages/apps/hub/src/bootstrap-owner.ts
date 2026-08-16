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
 * deliberately removed does not silently regrow one.
 *
 * @module hub/bootstrap-owner
 */

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHubUser, listHubUsers, type HubAuth } from '@slayzone/hub-auth/server'
import {
  ownerFilePath,
  readBootstrapOwner,
  type BootstrapOwnerFile
} from '@slayzone/platform/hub-owner-file'

// Re-exported for existing consumers of this module (tests, install-handshake) —
// the schema and reader now live in `@slayzone/platform/hub-owner-file` so the
// CLI can read the SAME file without depending on this app package. See that
// module's docstring for why.
export { ownerFilePath, readBootstrapOwner, type BootstrapOwnerFile }

async function writeOwnerFile(dataRoot: string, file: BootstrapOwnerFile): Promise<void> {
  const target = ownerFilePath(dataRoot)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
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

/**
 * Ensure this standalone hub has an owner, creating one on first boot.
 *
 * Returns the owner, or null when one already existed (nothing was written) — so
 * the caller knows whether to print credentials, which must happen exactly once.
 */
export async function ensureBootstrapOwner(
  auth: HubAuth,
  dataRoot: string,
  log: (message: string) => void = () => undefined
): Promise<BootstrapOwnerFile | null> {
  const existing = await listHubUsers(auth)
  // Service accounts (the computer-transport principal) are not people and must
  // not count as "this hub already has an owner".
  const people = existing.filter((u) => !u.email.endsWith('.internal'))
  if (people.length > 0) return null

  const email = 'owner@hub.slayzone.local'
  const created = await createHubUser(auth, { email, name: 'Hub owner' })
  if ('error' in created) {
    // Raced with something else creating the same address. Not fatal: the hub has
    // an owner either way, which is the only postcondition that matters.
    log('[slayzone] hub owner already present — skipping bootstrap')
    return null
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
  return file
}
