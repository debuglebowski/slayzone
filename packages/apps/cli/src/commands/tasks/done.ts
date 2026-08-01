import { apiPost } from '../../api'
import { resolveId } from './_shared'

export interface DoneOpts {
  close?: boolean
}

export async function doneAction(idPrefix: string | undefined, opts: DoneOpts): Promise<void> {
  idPrefix = await resolveId(idPrefix)

  // POST /api/tasks/:id/done expresses the INTENT ("mark this done") and lets the
  // hub decide which column that means for the task's project — the completed
  // category, via `getDoneStatus`. That decision used to happen here, which meant
  // reading `projects.columns_config` out of the hub's SQLite file: `openDb()`
  // exits 1 when the file is absent, so `slay tasks done` could never work against
  // a hub on another machine.
  //
  // Not `PATCH /api/tasks/:id { status: 'done' }`: PATCH resolves `status` as an
  // ALIAS against the project's columns (id / label / slug), so a project whose
  // completed column is `closed` would 400 — while the done intent still has an
  // unambiguous answer there. Sending a concrete status would just move the
  // category lookup back into the CLI.
  //
  // `--close` rides along in the same request. It used to call getServerPort()
  // (itself another DB read) and post to /api/close-task/:id; the hub now closes
  // the tab over the same injected menu bus that route uses, and reports whether
  // anything could — a hub with no UI (standalone) answers `closed: false`.
  const { data: task } = await apiPost<{
    ok: true
    data: { id: string; title: string; status: string; closed: boolean }
  }>(`/api/tasks/${encodeURIComponent(idPrefix)}/done`, opts.close ? { close: true } : {})

  console.log(`Done: ${task.id.slice(0, 8)}  ${task.title}`)

  if (opts.close && !task.closed) {
    console.error('Warning: cannot close tab — no app window attached to this hub')
  }
}
