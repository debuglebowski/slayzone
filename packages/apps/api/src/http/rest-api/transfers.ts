import type { Express } from 'express'
import { beginTaskMoveInputSchema, beginProjectMoveInputSchema } from '@slayzone/task-contracts'
import { taskMoveOps, taskOps } from '@slayzone/task/server'
import type { RestApiDeps } from './types'
import { restPrincipalOf } from './principal'
import { isResolveFailure, resolveByIdPrefix, resolveProjectRef } from './resolve'
import { respondFrameTooLarge } from './computer-frame-limit'

/** REST owns its transport gates; domain operations are shared with the UI. */
export function registerTransferRoutes(app: Express, deps: RestApiDeps): void {
  for (const scope of ['tasks', 'projects'] as const) {
    for (const mode of ['move', 'copy'] as const) {
      app.post(`/api/${scope}/:id/${mode}`, async (req, res) => {
        try {
          const body = req.body ?? {}
          const opts = { createdBy: restPrincipalOf(req)?.userId ?? null }
          const source =
            scope === 'tasks'
              ? await resolveByIdPrefix<{ id: string }>(
                  deps.db,
                  'tasks',
                  req.params.id,
                  'Task',
                  'id'
                )
              : await resolveProjectRef(deps.db, req.params.id)
          if (isResolveFailure(source)) {
            res.status(source.status).json({ ok: false, error: source.error })
            return
          }
          const crossHub = typeof body.hub === 'string' && body.hub.length > 0
          const project =
            scope === 'tasks' && !crossHub
              ? await resolveProjectRef(deps.db, body.project ?? '')
              : null
          if (project && isResolveFailure(project)) {
            res.status(project.status).json({ ok: false, error: project.error })
            return
          }
          let data: unknown
          if (scope === 'tasks' && mode === 'move' && !crossHub) {
            const targetProjectId = project && !isResolveFailure(project) ? project.row.id : ''
            const input = {
              taskIds: [source.row.id],
              targetProjectId,
              includeSubtasks: body.includeSubtasks !== false
            }
            const preview = await taskOps.previewMoveToProjectOp(deps.db, input)
            data = await taskOps.moveTasksToProjectRequestOp(
              deps.db,
              {
                ...input,
                keepSessionTabIds:
                  body.includeSessions === false
                    ? []
                    : preview.sessions.filter((tab) => tab.canKeep).map((tab) => tab.tabId)
              },
              { onMutation: deps.notifyRenderer, ipcMain: deps.taskBus }
            )
          } else {
            if (scope === 'projects' && mode === 'move' && !crossHub) {
              res.status(400).json({ ok: false, error: 'Project moves require --hub.' })
              return
            }
            const common = {
              id: body.id,
              mode,
              requestRunner: crossHub,
              targetHubId: crossHub ? body.hub : 'same-hub',
              includeSessions: body.includeSessions !== false
            }
            if (scope === 'tasks') {
              const input = beginTaskMoveInputSchema.parse({
                ...common,
                taskIds: [source.row.id],
                targetProjectId: crossHub
                  ? body.project
                  : project && !isResolveFailure(project)
                    ? project.row.id
                    : '',
                includeSubtasks: body.includeSubtasks !== false,
                title: body.title
              })
              data = crossHub
                ? await taskMoveOps.beginTaskMove(deps.db, input, opts)
                : await taskMoveOps.copyOnHub(deps.db, input, opts)
            } else {
              const input = beginProjectMoveInputSchema.parse({
                ...common,
                projectId: source.row.id,
                name: body.name
              })
              data = crossHub
                ? await taskMoveOps.beginProjectMove(deps.db, input, opts)
                : await taskMoveOps.copyOnHub(deps.db, input, opts)
            }
          }
          deps.notifyRenderer()
          res.json({ ok: true, data })
        } catch (error) {
          if (respondFrameTooLarge(res, error)) return
          res
            .status(400)
            .json({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
    }
  }
  app.get('/api/task-moves', async (_req, res) => {
    res.json({ ok: true, data: await taskMoveOps.listTaskMoves(deps.db) })
  })
  app.get('/api/task-moves/:id', async (req, res) => {
    try {
      res.json({ ok: true, data: await taskMoveOps.getTaskMove(deps.db, req.params.id) })
    } catch (error) {
      if (respondFrameTooLarge(res, error)) return
      res.status(404).json({ ok: false, error: String(error) })
    }
  })
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/task-moves/:id/${action}`, async (req, res) => {
      try {
        res.json({
          ok: true,
          data: await taskMoveOps.requestTaskMoveRunner(deps.db, req.params.id, action)
        })
      } catch (error) {
        if (respondFrameTooLarge(res, error)) return
        res.status(400).json({ ok: false, error: String(error) })
      }
    })
  }
}
