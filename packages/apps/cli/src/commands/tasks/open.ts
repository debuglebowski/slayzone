import { apiPost } from '../../api'
import { resolveId } from './_shared'

export interface OpenOpts {
  background?: boolean
  start?: boolean
  wait?: boolean
  timeout?: string
}

export async function openAction(idPrefix: string | undefined, opts: OpenOpts = {}): Promise<void> {
  idPrefix = await resolveId(idPrefix)

  // POST /api/open-task/:id owns id-prefix resolution (404 not-found / 400
  // ambiguous, same messages), the open broadcast, and the window raise. It
  // returns the resolved `{ id, title }` — which is also what makes the
  // subsequent `pty/start` correct, since that needs the FULL task id.
  //
  // This replaces a hand-rolled http.request to 127.0.0.1:<getServerPort()>:
  // both the port lookup and the prefix resolution read the hub's DB file, so
  // neither could work against a hub on another machine. `apiPost` routes
  // through the same hub target (env / cli-hub-target.json / --hub) as every other command
  // and falls back to the local app exactly as before.
  const { data: task } = await apiPost<{ ok: true; data: { id: string; title: string } }>(
    `/api/open-task/${encodeURIComponent(idPrefix)}${opts.background ? '?background=1' : ''}`,
    {}
  )

  if (opts.start) {
    const timeoutMs = opts.wait === false ? 0 : parseInt(opts.timeout ?? '5000', 10)
    const r = await apiPost<{ ok: boolean; alreadyAlive?: boolean; sessionId?: string }>(
      '/api/pty/start',
      { taskId: task.id, timeoutMs }
    )
    const startLabel = r.alreadyAlive ? 'already alive' : 'started'
    console.log(
      `${opts.background ? 'Opening (bg)' : 'Opening'} + ${startLabel}: ${task.id.slice(0, 8)}  ${task.title}`
    )
    return
  }
  console.log(
    `${opts.background ? 'Opening (bg)' : 'Opening'}: ${task.id.slice(0, 8)}  ${task.title}`
  )
}
