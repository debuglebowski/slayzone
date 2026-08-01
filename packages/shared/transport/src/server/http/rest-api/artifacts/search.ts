import type { Express } from 'express'
import { createArtifactStore } from '@slayzone/task/server'
import type { RestApiDeps } from '../types'
import { isResolveFailure, queryString, resolveByIdPrefix } from '../resolve'
import { getArtifactsDataRoot } from './shared'

/**
 * GET /api/artifacts/search — the hub half of `slay tasks artifacts search`.
 *
 * The scan reads every in-scope artifact's CURRENT VERSION out of the
 * content-addressed blob store, which only the host holding that store can do —
 * so the command had to open the hub's SQLite file + blob dir directly and died
 * against a hub on another machine. The matching itself lives in the domain
 * (`@slayzone/task-artifacts`'s `searchArtifacts`, lifted from the CLI verbatim)
 * and runs as ONE named txn, so the whole scan is a single round trip.
 *
 * Query params mirror the CLI flags 1:1:
 *   q, taskId | allTasks, folderId, titlesOnly, contentOnly, regex,
 *   caseSensitive, limit, maxMatches
 *
 * The response is `{ results, scannedCount, truncated, skippedLarge }`:
 * `results` IS the array the CLI's `--json` prints (unchanged shape), and the
 * other three feed its human footer / stderr notices, which the CLI still
 * renders itself so its wording and colors stay client-side.
 *
 * The three argument-contradiction checks (empty query, titles+content,
 * all-tasks+task/folder) are re-asserted here with the CLI's exact wording, so a
 * caller that reaches the route directly gets the same answers. The CLI keeps its
 * own copies too — they must fail BEFORE any request, as they always did.
 */
export function registerArtifactsSearchRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/artifacts/search', async (req, res) => {
    try {
      const query = queryString(req.query.q) ?? ''
      const allTasks = queryString(req.query.allTasks) != null
      const taskRef = queryString(req.query.taskId)
      const folderRef = queryString(req.query.folderId)
      const titlesOnly = queryString(req.query.titlesOnly) != null
      const contentOnly = queryString(req.query.contentOnly) != null

      if (!query.trim()) {
        res.status(400).json({ ok: false, error: 'Provide a non-empty query.' })
        return
      }
      if (titlesOnly && contentOnly) {
        res
          .status(400)
          .json({ ok: false, error: '--titles-only and --content-only are mutually exclusive.' })
        return
      }
      if (allTasks && (taskRef || folderRef)) {
        res
          .status(400)
          .json({ ok: false, error: '--all-tasks cannot combine with --task or --folder.' })
        return
      }
      if (!allTasks && !taskRef) {
        res
          .status(400)
          .json({ ok: false, error: 'taskId required (or allTasks to search every task).' })
        return
      }

      // Both scopes are addressed by id PREFIX, exactly as the CLI's
      // resolveTaskForArtifact / resolveFolder did — same 404/400 wording.
      let taskId: string | null = null
      if (!allTasks && taskRef) {
        const task = await resolveByIdPrefix<{ id: string }>(
          deps.db,
          'tasks',
          taskRef,
          'Task',
          'id'
        )
        if (isResolveFailure(task)) {
          res.status(task.status).json({ ok: false, error: task.error })
          return
        }
        taskId = task.row.id
      }
      let folderId: string | null = null
      if (folderRef) {
        const folder = await resolveByIdPrefix<{ id: string }>(
          deps.db,
          'artifact_folders',
          folderRef,
          'Folder',
          'id'
        )
        if (isResolveFailure(folder)) {
          res.status(folder.status).json({ ok: false, error: folder.error })
          return
        }
        folderId = folder.row.id
      }

      const limitRaw = queryString(req.query.limit)
      const maxMatchesRaw = queryString(req.query.maxMatches)

      const report = await createArtifactStore(getArtifactsDataRoot()).searchArtifacts(deps.db, {
        query,
        taskId,
        folderId,
        titlesOnly,
        contentOnly,
        regex: queryString(req.query.regex) != null,
        caseSensitive: queryString(req.query.caseSensitive) != null,
        limit: limitRaw != null ? parseInt(limitRaw, 10) : undefined,
        maxMatches: maxMatchesRaw != null ? parseInt(maxMatchesRaw, 10) : undefined
      })
      res.json({ ok: true, data: report })
    } catch (err) {
      // An uncompilable `--regex` is the CALLER's mistake, so it must be a 400
      // with the CLI's own wording — not a 500. The worker re-throws it as
      // `[INVALID_REGEX] <message>` (its class identity does not cross the thread
      // boundary; see task/server/artifacts-txns.ts wrapVersionError).
      const raw = err instanceof Error ? err.message : String(err)
      const m = /^\[INVALID_REGEX\]\s([\s\S]*)$/.exec(raw)
      if (m) {
        res.status(400).json({ ok: false, code: 'INVALID_REGEX', error: `Invalid regex: ${m[1]}` })
        return
      }
      res.status(500).json({ ok: false, error: raw })
    }
  })
}
