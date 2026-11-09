import type { Express, Request, Response } from 'express'
import { getHubAdminDeps } from '@slayzone/content-erasure/router'
import {
  AdminContentErasureError,
  type AdminContentErasure,
  type ErasureActor
} from '@slayzone/content-erasure/admin'
import { restPrincipalOf } from '../principal'
import type { RestApiDeps } from '../types'

/**
 * REST: `/api/hub/content-erasure` — permanent erasure of a disabled account's
 * content, behind `slay hub users erase-content|erasure-status|retry-erasure|
 * erasure-receipt|computer-erasure-request|confirm-computer-erasure`. The REST twin of
 * the tRPC `hubUsers` erasure procedures (content-erasure router.ts) for the CLI.
 *
 * ITS OWN PATH, never a variant of `/api/hub/users`. That path is on the break-glass
 * allowlist (apps/hub rest-auth.ts `BREAK_GLASS_ROUTES`) so an emergency session can
 * disable an account; erasure riding on it made the session able to erase content. A
 * break-glass session stops access and reaches nothing else (O-6) — one rule, the
 * allowlist, decided at the gate for every route like `/trpc` refuses the token
 * outright (hub-trpc-context.ts). This path is not on it, so the gate refuses a
 * break-glass session here before this handler runs.
 *
 * BEHIND THE ORDINARY BEARER GATE (not self-guarded): the caller is the principal the
 * gate bound (`restPrincipalOf`), and only an admin with a full session may call it
 * (`REST_ADMIN_POLICY`, then the erasure service's own `requireAdmin`). No principal
 * (a hub without login) → 403, as before: erasure always names who did it.
 *
 * METHODS SAY WHAT HAPPENS. `GET ?view=preview|reports&userId=` only reads. Everything
 * that changes or exports state is `POST { action, … }`: `erase-content`,
 * `retry-erasure`, `receipt`, `computer-erasure-request`, `confirm-computer-erasure`.
 *
 * @module transport/rest-api/hub/content-erasure
 */
export const CONTENT_ERASURE_PATH = '/api/hub/content-erasure'

/** The verified hub admin with a full session, or a 403 written and null. */
function adminActor(req: Request, res: Response): ErasureActor | null {
  const principal = restPrincipalOf(req)
  if (principal?.role === 'admin' && principal.scopes.includes('full'))
    return { userId: principal.userId, role: principal.role, scopes: principal.scopes }
  res.status(403).json({
    ok: false,
    error: 'Content erasure requires an authenticated hub admin with a full session.'
  })
  return null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Run the operation `pick` chose (null: the request names none) and answer it. */
async function respond(
  res: Response,
  pick: (erasure: AdminContentErasure) => Promise<unknown> | null
): Promise<void> {
  const erasure = getHubAdminDeps()?.erasure
  if (!erasure) {
    res.status(503).json({ ok: false, error: 'Content erasure is unavailable.' })
    return
  }
  try {
    const pending = pick(erasure)
    if (!pending) {
      res.status(400).json({ ok: false, error: 'Invalid content erasure request.' })
      return
    }
    res.json({ ok: true, data: await pending })
  } catch (error) {
    if (error instanceof AdminContentErasureError)
      res
        .status(error.code === 'ADMIN_ONLY' ? 403 : error.code === 'USER_NOT_FOUND' ? 404 : 409)
        .json({ ok: false, code: error.code, error: error.message })
    else
      res.status(500).json({
        ok: false,
        error: 'The operation could not finish. Check cleanup status and retry.'
      })
  }
}

export function registerHubContentErasureRoutes(app: Express, _deps: RestApiDeps): void {
  // Read-only views.
  app.get(CONTENT_ERASURE_PATH, async (req, res) => {
    const actor = adminActor(req, res)
    if (!actor) return
    const view = text(req.query.view)
    const userId = text(req.query.userId)
    await respond(res, (erasure) => {
      if (view === 'preview' && userId) return erasure.preview({ actor, userId })
      if (view === 'reports' && userId) return erasure.reports({ actor, userId })
      return null
    })
  })

  // Everything that changes or exports state.
  app.post(CONTENT_ERASURE_PATH, async (req, res) => {
    const actor = adminActor(req, res)
    if (!actor) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const action = text(body.action)
    const userId = text(body.userId)
    const jobId = text(body.jobId)
    await respond(res, (erasure) => {
      if (action === 'erase-content' && userId && typeof body.confirmation === 'string')
        return erasure.erase({ actor, userId, confirmation: body.confirmation })
      if (action === 'retry-erasure' && jobId) return erasure.retry({ actor, jobId })
      if (action === 'receipt' && jobId) return erasure.receipt({ actor, jobId })
      if (
        action === 'computer-erasure-request' &&
        jobId &&
        typeof body.computerId === 'string' &&
        typeof body.hubUrl === 'string'
      )
        return erasure.computerRequest({
          actor,
          jobId,
          computerId: body.computerId,
          hubUrl: body.hubUrl
        })
      if (action === 'confirm-computer-erasure')
        return erasure.confirmComputer({ actor, receipt: body.receipt })
      return null
    })
  })
}
