/**
 * Runner-side filesystem exec handlers: existence checks and directory removal
 * scoped to the runner's configured allowedRoots. Every path passes the
 * {@link assertPathAllowed} realpath containment guard before any access.
 *
 * The fs.* frame method names + param shapes are OWNED by the parallel
 * Wave2-A2 unit and are not yet in `@slayzone/fleet/shared`; the names/schemas
 * below MIRROR the agreed contract and a later integration reconciles them.
 *
 * @module runner/handlers/fs
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { assertPathAllowed } from '../config'
import type { HandlerContext, HubMethodTable } from './types'

/** fs.* method names. Mirrors the Wave2-A2 frame contract. */
export const FsMethods = {
  pathExists: 'fs.pathExists',
  removeDir: 'fs.removeDir'
} as const

const pathExistsParams = z.object({ path: z.string().min(1) })
const removeDirParams = z.object({ path: z.string().min(1) })

export function createFsHandlers(ctx: HandlerContext): HubMethodTable {
  const roots = ctx.config.allowedRoots

  function pathExists(rawParams: unknown): { exists: boolean } {
    const { path } = pathExistsParams.parse(rawParams)
    const resolved = assertPathAllowed(path, roots)
    return { exists: existsSync(resolved) }
  }

  async function removeDir(rawParams: unknown): Promise<{ ok: true }> {
    const { path } = removeDirParams.parse(rawParams)
    const resolved = assertPathAllowed(path, roots)
    await rm(resolved, { recursive: true, force: true })
    ctx.log('fs removeDir', { path: resolved })
    return { ok: true }
  }

  return {
    [FsMethods.pathExists]: pathExists,
    [FsMethods.removeDir]: removeDir
  }
}
