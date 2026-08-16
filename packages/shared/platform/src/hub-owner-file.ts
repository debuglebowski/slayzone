/**
 * `<dataRoot>/hub.owner.json` — the read-side contract shared between the hub
 * (which writes it) and the CLI (which reads it).
 *
 * WHY THIS IS A SHARED LEAF, NOT HUB-LOCAL. `packages/apps/hub` provisions the
 * file (`bootstrap-owner.ts`), and `packages/apps/cli` needs to read its `token`
 * to authenticate on-box callers — `slay hub users add`, and every in-task agent,
 * on a standalone hub that now requires auth from everyone. Apps do not depend on
 * apps in this monorepo, so the schema has to live somewhere both can reach
 * without the CLI pulling in the hub's dependency graph (better-auth, node:sqlite,
 * express). `@slayzone/platform` is that place — dependency-light by design, the
 * same reason `hub-addr.ts` is a lean subpath import.
 *
 * NO ZOD HERE, deliberately: `platform` carries no runtime dependencies, and this
 * file already had a defensive hand-rolled parse for its config counterparts
 * (`allowedRoots` in slayzone-config.ts). The hub's write side keeps using zod —
 * this module only has to describe the SAME shape, not share the validator.
 *
 * The write side (`ensureBootstrapOwner`, which needs a live `HubAuth` to create
 * the account) stays in `packages/apps/hub/src/bootstrap-owner.ts`, importing this
 * module rather than duplicating it.
 *
 * @module platform/hub-owner-file
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface BootstrapOwnerFile {
  userId: string
  email: string
  /** Kept so a boot after session expiry can sign in again without a human. */
  password: string
  /** Bearer for loopback/co-located callers on this box (`slay`, in-task agents). */
  token?: string
  createdAt: number
}

export function ownerFilePath(dataRoot: string): string {
  return join(dataRoot, 'hub.owner.json')
}

/** Non-throwing shape check. Rejects anything that isn't a plausible file rather
 *  than trusting `JSON.parse`'s output blindly. */
function parseOwnerFile(value: unknown): BootstrapOwnerFile | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.userId !== 'string' || v.userId.length === 0) return null
  if (typeof v.email !== 'string' || v.email.length === 0) return null
  if (typeof v.password !== 'string' || v.password.length === 0) return null
  if (typeof v.createdAt !== 'number') return null
  if (v.token !== undefined && (typeof v.token !== 'string' || v.token.length === 0)) return null
  return {
    userId: v.userId,
    email: v.email,
    password: v.password,
    createdAt: v.createdAt,
    ...(typeof v.token === 'string' ? { token: v.token } : {})
  }
}

/**
 * Read `<dataRoot>/hub.owner.json`, or null on ANY failure — missing file, wrong
 * OS user (permission denied), corrupt JSON, or a shape that doesn't match.
 *
 * Fails silent by design: every caller uses this as one fallback among several
 * (env var, `cli-hub-target.json`, discovery), so a read failure here must fall
 * through rather than abort the command.
 */
export async function readBootstrapOwner(dataRoot: string): Promise<BootstrapOwnerFile | null> {
  try {
    const raw = await readFile(ownerFilePath(dataRoot), 'utf-8')
    return parseOwnerFile(JSON.parse(raw))
  } catch {
    return null
  }
}
