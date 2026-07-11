import { apiGet, apiPost } from '../../api'
import { resolveId } from './_shared'

export interface BlockedOpts {
  on?: boolean
  off?: boolean
  toggle?: boolean
  comment?: string | false
  json?: boolean
}

interface BlockedState {
  is_blocked: boolean
  blocked_comment: string | null
  blockers: { id: string; title: string }[]
}

export async function blockedAction(taskId: string | undefined, opts: BlockedOpts): Promise<void> {
  taskId = await resolveId(taskId)
  const path = `/api/tasks/${encodeURIComponent(taskId)}/blocked`

  // The REST route owns id-prefix resolution, the is_blocked / blocked_comment
  // mutation, the renderer ping, and re-reading the resulting state (+ the
  // dependency-blocker context list). --no-comment → commander sets opts.comment
  // = false, which maps to `{ comment: null }` (clear the comment only).
  const isWrite = opts.on || opts.off || opts.toggle || opts.comment !== undefined
  let state: BlockedState
  if (isWrite) {
    const body: Record<string, unknown> = {}
    if (opts.on) body.on = true
    else if (opts.off) body.off = true
    else if (opts.toggle) body.toggle = true
    else if (opts.comment === false) body.comment = null
    else if (opts.comment !== undefined) body.comment = opts.comment
    ;({ data: state } = await apiPost<{ ok: true; data: BlockedState }>(path, body))
  } else {
    ;({ data: state } = await apiGet<{ ok: true; data: BlockedState }>(path))
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          is_blocked: state.is_blocked,
          blocked_comment: state.blocked_comment,
          blockers: state.blockers.map((b) => ({ id: b.id, title: b.title }))
        },
        null,
        2
      )
    )
  } else {
    console.log(
      `Blocked: ${state.is_blocked ? 'yes' : 'no'}${state.blocked_comment ? ` (${state.blocked_comment})` : ''}`
    )
    if (state.blockers.length > 0) {
      console.log(
        `Blockers: ${state.blockers.map((b) => `${b.id.slice(0, 8)} (${b.title})`).join(', ')}`
      )
    }
  }
}
