/**
 * Moving a whole project between two hubs, end to end through each hub's real router
 * and the app's step engine: the project and its own rows (tags, automations without
 * their runs, templates, test labels, AI config, settings, icon, history) arrive on the
 * target with their ids, ungrouped and owned by the importer, together with every task;
 * both hubs hide or lock it while it moves; the source then lets it go (removed, not
 * erased) and leaves a redirect. Cancel before commit leaves both hubs as they were; a
 * move back works; an empty project moves; a linked or half-deleted project does not.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/project-moves-two-hubs.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { CreateTaskInput, Task, TaskMove } from '@slayzone/task-contracts'
import {
  configureTaskRuntimeAdapters,
  projectMovingSql,
  setTaskDeps,
  setTaskMoveSessionsDelegate,
  taskOps,
  type TaskMoveSessionsDelegate
} from '@slayzone/task/server'
import { createTaskMoveSteps, runTaskMove } from '@slayzone/task/client'
import {
  defaultWorktreeExecAdapters,
  defaultWorktreePolicyAdapters
} from '@slayzone/worktrees/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { appRouter } from '../router'

const A = await createTestHarness()
const B = await createTestHarness()
const rootA = mkdtempSync(join(tmpdir(), 'project-moves-hub-a-'))
const rootB = mkdtempSync(join(tmpdir(), 'project-moves-hub-b-'))
setTaskDeps({ ops: taskOps })
configureTaskRuntimeAdapters({
  getDataRoot: () => rootA,
  worktrees: defaultWorktreeExecAdapters,
  worktreePolicy: defaultWorktreePolicyAdapters
})
const hubA = appRouter.createCaller({ db: A.slayDb, dataRoot: rootA } as never)
const hubB = appRouter.createCaller({ db: B.slayDb, dataRoot: rootB } as never)

/** Computers holding no sessions: a move that keeps sessions copies nothing. */
const forgotten: string[][] = []
setTaskMoveSessionsDelegate({
  exportTask: async () => ({ transfers: [], ledger: null }),
  files: async () => [],
  discard: async () => undefined,
  forget: async (taskIds: readonly string[]) => {
    forgotten.push([...taskIds])
  },
  holders: async () => [],
  forgetOn: async () => undefined,
  computerOf: async () => 'computer-b',
  missingFiles: async () => [],
  writeFile: async () => undefined,
  importLedger: async () => undefined,
  settle: async () => undefined
} as unknown as TaskMoveSessionsDelegate)

type Hub = typeof hubA
type Harness = typeof A

/** The app's side: begin the project move on the source, then the step engine. */
async function moveProject(
  from: { hub: Hub; id: string },
  to: { hub: Hub; id: string },
  projectId: string,
  opts: { pauseBefore?: TaskMove['step']; includeSessions?: boolean; resumeId?: string } = {}
): Promise<TaskMove> {
  const begun = opts.resumeId
    ? await from.hub.taskMoves.resume({ id: opts.resumeId })
    : await from.hub.taskMoves.beginProject({
        projectId,
        targetHubId: to.id,
        includeSessions: opts.includeSessions ?? false
      })
  let lastStep: TaskMove['step'] = begun.step
  return runTaskMove(begun.id, {
    journal: {
      get: (id) => from.hub.taskMoves.get({ id }),
      advance: (id, completed) => from.hub.taskMoves.advance({ id, completed }),
      progress: (id, step, done, total) => from.hub.taskMoves.progress({ id, step, done, total }),
      pause: (id) => from.hub.taskMoves.pause({ id }),
      fail: (id, error) => from.hub.taskMoves.fail({ id, error }),
      release: (id) => from.hub.taskMoves.release({ id })
    },
    steps: createTaskMoveSteps({
      sourceHubId: from.id,
      source: {
        exportBundle: (id) => from.hub.taskMoves.export({ id }),
        addRemoteBlockers: (moveId, links) =>
          from.hub.taskMoves.addRemoteBlockers({ moveId, links }).then(() => undefined),
        fileManifest: (moveId) => from.hub.artifacts.moveManifest({ moveId }),
        readFile: (moveId, ref, offset, length) =>
          from.hub.artifacts.moveRead({ moveId, ref, offset, length }),
        sessionsExport: (moveId, taskId) => from.hub.taskMoves.sessionsExport({ moveId, taskId }),
        sessionsRead: (input) => from.hub.taskMoves.sessionsRead(input),
        sessionsReadAttachment: (input) => from.hub.taskMoves.sessionsReadAttachment(input),
        sessionsFiles: (moveId, taskId) => from.hub.taskMoves.sessionsFiles({ moveId, taskId }),
        sessionsFileRead: (input) => from.hub.taskMoves.sessionsFileRead(input),
        sessionsDiscard: (moveId) => from.hub.taskMoves.sessionsDiscard({ moveId })
      },
      target: {
        importBundle: (input) => to.hub.taskMoves.import(input).then(() => undefined),
        addRemoteBlockers: (moveId, links) =>
          to.hub.taskMoves.addRemoteBlockers({ moveId, links }).then(() => undefined),
        missingFiles: (moveId, entries) => to.hub.artifacts.moveMissing({ moveId, entries }),
        writeFile: (input) => to.hub.artifacts.moveWrite(input).then(() => undefined),
        clearStaging: (moveId) => to.hub.artifacts.moveClearStaging({ moveId }),
        sessionsBegin: (moveId, taskId, manifest) =>
          to.hub.taskMoves.sessionsBegin({ moveId, taskId, manifest }),
        sessionsChunk: (input) => to.hub.taskMoves.sessionsChunk(input),
        sessionsFinish: (moveId, taskId, transferId) =>
          to.hub.taskMoves.sessionsFinish({ moveId, taskId, transferId }),
        sessionsPutAttachment: (input) => to.hub.taskMoves.sessionsPutAttachment(input),
        sessionsActivate: (input) => to.hub.taskMoves.sessionsActivate(input),
        sessionsFilesMissing: (moveId, taskId, entries) =>
          to.hub.taskMoves.sessionsFilesMissing({ moveId, taskId, entries }),
        sessionsFileWrite: (input) => to.hub.taskMoves.sessionsFileWrite(input),
        sessionsImportLedger: (moveId, taskId, ledger) =>
          to.hub.taskMoves.sessionsImportLedger({ moveId, taskId, ledger }),
        sessionsRegister: (moveId, taskId, chats) =>
          to.hub.taskMoves.sessionsRegister({ moveId, taskId, chats }),
        commit: (id) => to.hub.taskMoves.commit({ id }).then(() => undefined)
      }
    }),
    // Pauses before running `pauseBefore` (the steps before it are done).
    pauseRequested: () => lastStep === opts.pauseBefore,
    onUpdate: (m) => {
      lastStep = m.step
    }
  })
}

const count = (h: Harness, sql: string, ...params: unknown[]) =>
  (h.db.prepare(sql).get(...params) as { n: number }).n
const one = (h: Harness, sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).get(...params) as Record<string, unknown> | undefined
const errOf = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await fn()
    return { message: '' }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}
const listed = async (hub: Hub, projectId: string): Promise<boolean> =>
  (await hub.projects.list()).some((p) => p.id === projectId)

const COLUMNS = [
  { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
]

/** A project on `h` with something in every table a project move carries. */
async function seedProject(h: Harness, hub: Hub, root: string, name: string) {
  const projectId = crypto.randomUUID()
  const group = crypto.randomUUID()
  h.db.prepare("INSERT INTO project_groups (id, name) VALUES (?, 'Group')").run(group)
  const iconDir = join(root, 'project-icons')
  mkdirSync(iconDir, { recursive: true })
  const icon = join(iconDir, `${projectId}.png`)
  writeFileSync(icon, 'png-bytes')
  h.db
    .prepare(
      `INSERT INTO projects (id, name, color, columns_config, group_id, icon_image_path)
       VALUES (?, ?, '#123456', ?, ?, ?)`
    )
    .run(projectId, name, JSON.stringify(COLUMNS), group, icon)
  const ids = {
    tagUsed: crypto.randomUUID(),
    tagUnused: crypto.randomUUID(),
    automation: crypto.randomUUID(),
    template: crypto.randomUUID(),
    testCategory: crypto.randomUUID(),
    testLabel: crypto.randomUUID(),
    aiItem: crypto.randomUUID(),
    aiSelection: crypto.randomUUID(),
    activity: crypto.randomUUID()
  }
  const run = (sql: string, ...params: unknown[]) => h.db.prepare(sql).run(...params)
  run(
    "INSERT INTO tags (id, project_id, name, color, text_color) VALUES (?, ?, 'bug', '#ef4444', '#ffffff')",
    ids.tagUsed,
    projectId
  )
  run(
    "INSERT INTO tags (id, project_id, name, color, text_color) VALUES (?, ?, 'idea', '#22c55e', '#ffffff')",
    ids.tagUnused,
    projectId
  )
  run(
    `INSERT INTO automations (id, project_id, name, enabled, trigger_config, actions, run_count)
     VALUES (?, ?, 'Nightly', 1, '{"type":"cron","params":{"expression":"0 3 * * *"}}', '[]', 7)`,
    ids.automation,
    projectId
  )
  run(
    "INSERT INTO automation_runs (id, automation_id, status) VALUES (?, ?, 'success')",
    crypto.randomUUID(),
    ids.automation
  )
  run(
    "INSERT INTO task_templates (id, project_id, name, is_default) VALUES (?, ?, 'Bug', 1)",
    ids.template,
    projectId
  )
  run(
    "INSERT INTO test_categories (id, project_id, name, pattern) VALUES (?, ?, 'Unit', '*.test.ts')",
    ids.testCategory,
    projectId
  )
  run(
    "INSERT INTO test_labels (id, project_id, name) VALUES (?, ?, 'flaky')",
    ids.testLabel,
    projectId
  )
  run(
    "INSERT INTO test_file_labels (project_id, file_path, label_id) VALUES (?, 'a.test.ts', ?)",
    projectId,
    ids.testLabel
  )
  run(
    "INSERT INTO test_file_notes (project_id, file_path, note) VALUES (?, 'a.test.ts', 'slow')",
    projectId
  )
  run(
    `INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content)
     VALUES (?, 'skill', 'project', ?, 'Deploy', 'deploy', 'steps')`,
    ids.aiItem,
    projectId
  )
  run(
    `INSERT INTO ai_config_project_selections (id, project_id, item_id, provider, target_path)
     VALUES (?, ?, ?, 'claude', '.claude/skills/deploy/SKILL.md')`,
    ids.aiSelection,
    projectId,
    ids.aiItem
  )
  run(
    `INSERT INTO activity_events (id, entity_type, entity_id, project_id, kind, actor_type, source, summary)
     VALUES (?, 'project', ?, ?, 'project.updated', 'user', 'ui', 'Renamed')`,
    ids.activity,
    projectId,
    projectId
  )
  run('INSERT INTO settings (key, value) VALUES (?, ?)', `ai_providers:${projectId}`, '["claude"]')
  run('INSERT INTO settings (key, value) VALUES (?, ?)', `commit_graph:project:${projectId}`, '{}')
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'unrelated_setting', 'keep')

  const create = (title: string, extra = {}) =>
    hub.task.create({ projectId, title, ...extra } as unknown as CreateTaskInput) as Promise<Task>
  const parent = await create('Parent')
  const child = await create('Child', { parentId: parent.id })
  const archived = await create('Archived')
  await hub.task.archive({ id: archived.id })
  run('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)', parent.id, ids.tagUsed)
  const artifact = await hub.artifacts.create({
    taskId: parent.id,
    title: 'notes.md',
    content: 'project notes'
  })
  return {
    projectId,
    group,
    ids,
    tasks: { parent: parent.id, child: child.id, archived: archived.id },
    artifactId: artifact!.id
  }
}

describe('moving a project to another hub', () => {
  test('the project, its own rows and its tasks arrive with their ids; the source lets go', async () => {
    const seeded = await seedProject(A, hubA, rootA, 'Moving')
    const { projectId, ids, tasks } = seeded
    // A blocker with a task in another project on A: becomes a link between the hubs.
    const otherProject = crypto.randomUUID()
    A.db
      .prepare("INSERT INTO projects (id, name, color) VALUES (?, 'Stays', '#000')")
      .run(otherProject)
    const stays = (await hubA.task.create({
      projectId: otherProject,
      title: 'Stays'
    } as unknown as CreateTaskInput)) as Task
    A.db
      .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
      .run(stays.id, tasks.parent)

    const preview = await hubA.taskMoves.projectPreview({ projectId })
    expect(preview).toEqual({
      taskCount: 3,
      linkedToIntegration: false,
      deletionPending: false,
      alreadyMoving: false,
      externalBlockerCount: 1
    })

    const done = await moveProject(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b' },
      projectId
    )
    expect(done.status).toBe('done')
    expect(done.scope).toBe('project')
    expect(done.projectId).toBe(projectId)

    // On B: the project, same id, ungrouped, no owner (no login here), listed.
    const project = one(B, 'SELECT * FROM projects WHERE id = ?', projectId)!
    expect(project.name).toBe('Moving')
    expect(project.color).toBe('#123456')
    expect(project.group_id).toBeNull()
    expect(project.owner_user_id).toBeNull()
    expect(project.icon_image_path).toBe(join(rootB, 'project-icons', `${projectId}.png`))
    expect(readFileSync(join(rootB, 'project-icons', `${projectId}.png`), 'utf8')).toBe('png-bytes')
    expect(await listed(hubB, projectId)).toBe(true)
    // Its own rows, ids kept; automations kept with their switch; their runs left behind.
    expect(count(B, 'SELECT COUNT(*) AS n FROM tags WHERE project_id = ?', projectId)).toBe(2)
    expect(one(B, 'SELECT id FROM tags WHERE id = ?', ids.tagUnused)).toBeDefined()
    expect(
      one(B, 'SELECT enabled, run_count FROM automations WHERE id = ?', ids.automation)
    ).toEqual({ enabled: 1, run_count: 7 })
    expect(count(B, 'SELECT COUNT(*) AS n FROM automation_runs')).toBe(0)
    expect(one(B, 'SELECT is_default FROM task_templates WHERE id = ?', ids.template)).toEqual({
      is_default: 1
    })
    expect(one(B, 'SELECT id FROM test_categories WHERE id = ?', ids.testCategory)).toBeDefined()
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM test_file_labels WHERE project_id = ?', projectId)
    ).toBe(1)
    expect(one(B, 'SELECT note FROM test_file_notes WHERE project_id = ?', projectId)).toEqual({
      note: 'slow'
    })
    expect(one(B, 'SELECT slug FROM ai_config_items WHERE id = ?', ids.aiItem)).toEqual({
      slug: 'deploy'
    })
    expect(
      one(B, 'SELECT item_id FROM ai_config_project_selections WHERE id = ?', ids.aiSelection)
    ).toEqual({ item_id: ids.aiItem })
    expect(one(B, 'SELECT summary FROM activity_events WHERE id = ?', ids.activity)).toEqual({
      summary: 'Renamed'
    })
    expect(one(B, 'SELECT value FROM settings WHERE key = ?', `ai_providers:${projectId}`)).toEqual(
      {
        value: '["claude"]'
      }
    )
    // A per-user key: no users on B, so it becomes B's own value.
    expect(
      one(B, 'SELECT value FROM settings WHERE key = ?', `commit_graph:project:${projectId}`)
    ).toEqual({ value: '{}' })
    expect(one(B, 'SELECT value FROM settings WHERE key = ?', 'unrelated_setting')).toBeUndefined()
    // Every task, archived one included, with its tag (same id) and artifact.
    for (const id of Object.values(tasks))
      expect(one(B, 'SELECT project_id FROM tasks WHERE id = ?', id)).toEqual({
        project_id: projectId
      })
    expect(one(B, 'SELECT parent_id FROM tasks WHERE id = ?', tasks.child)).toEqual({
      parent_id: tasks.parent
    })
    expect(one(B, 'SELECT tag_id FROM task_tags WHERE task_id = ?', tasks.parent)).toEqual({
      tag_id: ids.tagUsed
    })
    expect(one(B, 'SELECT id FROM task_artifacts WHERE id = ?', seeded.artifactId)).toBeDefined()
    // The blocker to a task left on A is a link on both sides.
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM task_remote_blockers WHERE task_id = ?', tasks.parent)
    ).toBe(1)
    expect(
      count(A, 'SELECT COUNT(*) AS n FROM task_remote_blockers WHERE task_id = ?', stays.id)
    ).toBe(1)

    // On A: gone (removed, not erased), with a redirect; its settings and icon too.
    expect(one(A, 'SELECT id FROM projects WHERE id = ?', projectId)).toBeUndefined()
    expect(await listed(hubA, projectId)).toBe(false)
    for (const table of [
      'tags',
      'automations',
      'task_templates',
      'test_categories',
      'test_file_notes',
      'ai_config_items'
    ])
      expect(count(A, `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)).toBe(0)
    expect(
      count(A, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE '%' || ? || '%'", projectId)
    ).toBe(0)
    expect(one(A, 'SELECT value FROM settings WHERE key = ?', 'unrelated_setting')).toEqual({
      value: 'keep'
    })
    expect(existsSync(join(rootA, 'project-icons', `${projectId}.png`))).toBe(false)
    expect(count(A, 'SELECT COUNT(*) AS n FROM content_erasure_tasks')).toBe(0)
    expect(await hubA.taskMoves.projectRedirects({ projectIds: [projectId] })).toEqual({
      [projectId]: { hubId: 'hub-b', moveId: done.id }
    })
    expect(one(A, 'SELECT id FROM projects WHERE id = ?', otherProject)).toBeDefined()
  })

  test('while it moves, each hub hides or locks it, and its automations run on neither', async () => {
    const { projectId, ids, tasks } = await seedProject(A, hubA, rootA, 'In transit')
    const paused = await moveProject(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b' },
      projectId,
      { pauseBefore: 'copy-files' }
    )
    expect(paused.status).toBe('paused')
    // The source still lists it (until release); the target hides it until commit.
    expect(await listed(hubA, projectId)).toBe(true)
    expect(await listed(hubB, projectId)).toBe(false)
    expect(one(B, 'SELECT id FROM projects WHERE id = ?', projectId)).toBeDefined()
    // Writes to the project, its rows and its tasks are refused on both hubs.
    for (const hub of [hubA, hubB]) {
      const err = await errOf(() => hub.projects.update({ id: projectId, name: 'nope' }))
      expect(err.code).toBe('PRECONDITION_FAILED')
      expect(err.message).toMatch(/project is being moved/i)
    }
    expect(
      (await errOf(() => hubA.automations.toggle({ id: ids.automation, enabled: false }))).code
    ).toBe('PRECONDITION_FAILED')
    expect(
      (
        await errOf(() =>
          hubA.task.create({ projectId, title: 'late' } as unknown as CreateTaskInput)
        )
      ).code
    ).toBe('PRECONDITION_FAILED')
    expect(
      (await errOf(() => hubA.task.update({ id: tasks.parent, title: 'nope' } as never))).code
    ).toBe('PRECONDITION_FAILED')
    // The automation engine passes over a moving project's automations, on both hubs.
    const runnable = `SELECT COUNT(*) AS n FROM automations WHERE id = ? AND NOT ${projectMovingSql('automations.project_id')}`
    expect(count(A, runnable, ids.automation)).toBe(0)
    expect(count(B, runnable, ids.automation)).toBe(0)
    // A second move of the project, or of one of its tasks, is refused.
    expect(
      (await errOf(() => hubA.taskMoves.beginProject({ projectId, targetHubId: 'hub-b' }))).code
    ).toBe('CONFLICT')

    const done = await moveProject(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b' },
      projectId,
      { resumeId: paused.id }
    )
    expect(done.status).toBe('done')
    expect(await listed(hubB, projectId)).toBe(true)
    expect(count(B, runnable, ids.automation)).toBe(1)
    await hubB.projects.update({ id: projectId, name: 'Renamed on B' })
  })

  test('canceled before commit: the target drops it all, the source keeps it unlocked', async () => {
    const { projectId, tasks } = await seedProject(A, hubA, rootA, 'Canceled')
    const paused = await moveProject(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b' },
      projectId,
      { pauseBefore: 'commit' }
    )
    expect(existsSync(join(rootB, 'project-icons', `${projectId}.png`))).toBe(true)
    await hubB.taskMoves.abort({ id: paused.id })
    await hubA.taskMoves.cancel({ id: paused.id })

    expect(one(B, 'SELECT id FROM projects WHERE id = ?', projectId)).toBeUndefined()
    for (const table of ['tags', 'automations', 'task_templates', 'tasks'])
      expect(count(B, `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)).toBe(0)
    expect(
      count(B, "SELECT COUNT(*) AS n FROM settings WHERE key LIKE '%' || ? || '%'", projectId)
    ).toBe(0)
    expect(existsSync(join(rootB, 'project-icons', `${projectId}.png`))).toBe(false)
    expect(count(B, 'SELECT COUNT(*) AS n FROM content_erasure_tasks')).toBe(0)

    expect(await listed(hubA, projectId)).toBe(true)
    expect(one(A, 'SELECT id FROM tasks WHERE id = ?', tasks.parent)).toBeDefined()
    await hubA.projects.update({ id: projectId, name: 'Still here' })
    expect(one(A, 'SELECT name FROM projects WHERE id = ?', projectId)).toEqual({
      name: 'Still here'
    })
  })

  test('a moved project moves back, and an empty project moves too', async () => {
    const { projectId, tasks } = await seedProject(A, hubA, rootA, 'Round trip')
    await moveProject({ hub: hubA, id: 'hub-a' }, { hub: hubB, id: 'hub-b' }, projectId)
    const back = await moveProject(
      { hub: hubB, id: 'hub-b' },
      { hub: hubA, id: 'hub-a' },
      projectId,
      { includeSessions: true }
    )
    expect(back.error).toBeNull()
    expect(back.status).toBe('done')
    expect(one(A, 'SELECT name FROM projects WHERE id = ?', projectId)).toEqual({
      name: 'Round trip'
    })
    expect(one(A, 'SELECT project_id FROM tasks WHERE id = ?', tasks.child)).toEqual({
      project_id: projectId
    })
    // The redirect A left is cleared; B now has one pointing back.
    expect(await hubA.taskMoves.projectRedirects({ projectIds: [projectId] })).toEqual({})
    expect(await hubB.taskMoves.projectRedirects({ projectIds: [projectId] })).toEqual({
      [projectId]: { hubId: 'hub-a', moveId: back.id }
    })
    expect(one(B, 'SELECT id FROM projects WHERE id = ?', projectId)).toBeUndefined()

    const empty = crypto.randomUUID()
    A.db.prepare("INSERT INTO projects (id, name, color) VALUES (?, 'Empty', '#000')").run(empty)
    const moved = await moveProject({ hub: hubA, id: 'hub-a' }, { hub: hubB, id: 'hub-b' }, empty)
    expect(moved.status).toBe('done')
    expect(moved.taskIds).toEqual([])
    expect(await listed(hubB, empty)).toBe(true)
    expect(one(A, 'SELECT id FROM projects WHERE id = ?', empty)).toBeUndefined()
  })

  test('refused: a linked project, one with a deletion running, an id the target has', async () => {
    const linked = (await seedProject(A, hubA, rootA, 'Linked')).projectId
    const connection = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
         VALUES (?, 'linear', 'ref', 1, datetime('now'), datetime('now'))`
      )
      .run(connection)
    A.db
      .prepare(
        `INSERT INTO integration_project_mappings (id, project_id, provider, connection_id, external_team_id, external_team_key)
         VALUES (?, ?, 'linear', ?, 't', 'T')`
      )
      .run(crypto.randomUUID(), linked, connection)
    expect((await hubA.taskMoves.projectPreview({ projectId: linked })).linkedToIntegration).toBe(
      true
    )
    const linkedErr = await errOf(() =>
      hubA.taskMoves.beginProject({ projectId: linked, targetHubId: 'hub-b' })
    )
    expect(linkedErr.code).toBe('BAD_REQUEST')
    expect(linkedErr.message).toMatch(/integration/i)

    const deleting = await seedProject(A, hubA, rootA, 'Deleting')
    A.db
      .prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?")
      .run(deleting.tasks.archived)
    expect(
      (await hubA.taskMoves.projectPreview({ projectId: deleting.projectId })).deletionPending
    ).toBe(true)
    expect(
      (
        await errOf(() =>
          hubA.taskMoves.beginProject({ projectId: deleting.projectId, targetHubId: 'hub-b' })
        )
      ).message
    ).toMatch(/still being deleted/i)

    // The target already has a project with this id: the import is refused, nothing written.
    const clash = (await seedProject(A, hubA, rootA, 'Clash')).projectId
    B.db
      .prepare("INSERT INTO projects (id, name, color) VALUES (?, 'Clash on B', '#000')")
      .run(clash)
    const failed = await moveProject({ hub: hubA, id: 'hub-a' }, { hub: hubB, id: 'hub-b' }, clash)
    expect(failed.status).toBe('failed')
    expect(failed.step).toBe('import')
    expect(failed.error).toMatch(/already on this hub/i)
    expect(one(B, 'SELECT name FROM projects WHERE id = ?', clash)).toEqual({ name: 'Clash on B' })
    await hubA.taskMoves.cancel({ id: failed.id })
    expect(await listed(hubA, clash)).toBe(true)
  })
})
