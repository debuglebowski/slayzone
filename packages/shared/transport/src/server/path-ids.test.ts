/**
 * T-104: a task/project id never escapes into a path. `artifacts.cleanupTask('..')`
 * and `task.archiveMany(['..'])` removed the hub's data dir (DB included) on a hub
 * without login — every desktop app's own hub.
 *
 * Drives the real `appRouter` over the tRPC HTTP adapter (the same middleware chain and
 * error formatting the ws adapter uses) on a hub WITHOUT login (no principal, gate off:
 * the desktop's hub) and WITH login (a signed-in `user`), plus the REST and MCP twins of
 * archive-many. Every bad id is refused with BAD_REQUEST + `appCode: INVALID_ID` (REST
 * 400 `{ code }`, MCP `isError`); afterwards the data dir, the DB file, other tasks'
 * artifacts and other projects' icons are byte-identical and nothing appeared outside.
 * Valid ids still work. Also: a folder download cannot write outside the chosen
 * directory, and the blob store cannot name a path outside `blobs/`.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/shared/transport/src/server/path-ids.test.ts
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import {
  configureTaskRuntimeAdapters,
  createArtifactStore,
  downloadArtifactFolder,
  taskOps,
  type ArtifactDownloadHost
} from '@slayzone/task/server'
import { BlobStore } from '@slayzone/task-artifacts/server'
import { createTestHarness, describe, expect, test } from '../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../test-utils/rest-harness.js'
import { appRouter } from './router.js'
import { setAuthGate, setTaskDeps } from './app-deps.js'
import { registerArchiveManyTaskRoute } from './http/rest-api/tasks/archive-many.js'
import { registerArchiveManyTaskTool } from './http/mcp-tools/archive-many-task.js'
import type { RestApiDeps } from './http/rest-api/types.js'

const h = await createTestHarness()
setTaskDeps({ ops: taskOps })

// <root>/storage is the hub's data dir; <root> holds one file of its own.
const root = h.tmpDir()
const dataRoot = path.join(root, 'storage')
fs.mkdirSync(dataRoot)
configureTaskRuntimeAdapters({ getDataRoot: () => dataRoot })

const projectA = crypto.randomUUID()
const projectB = crypto.randomUUID()
const taskA = crypto.randomUUID()
const taskB = crypto.randomUUID()
for (const p of [projectA, projectB]) {
  h.db
    .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
    .run(p, p.slice(0, 4), '#000', h.tmpDir())
}
for (const t of [taskA, taskB]) {
  h.db
    .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
    .run(t, projectA, `task ${t.slice(0, 4)}`)
}

// Everything that must survive, byte for byte.
const sentinels: Record<string, string> = {
  [path.join(root, 'outside.txt')]: 'OUTSIDE',
  [path.join(dataRoot, 'slayzone.data.sqlite')]: 'LIVE-DB',
  [path.join(dataRoot, 'artifacts', taskB, 'keep.md')]: 'TASK-B',
  [path.join(dataRoot, 'project-icons', `${projectB}.png`)]: 'ICON-B',
  [path.join(dataRoot, 'project-icons', '.keep')]: 'DOTFILE'
}
for (const [file, bytes] of Object.entries(sentinels)) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}
// The blob store makes `blobs/` on the first valid create; make it now so the
// listing below is the same before and after.
fs.mkdirSync(path.join(dataRoot, 'blobs'))
const rootEntries = fs.readdirSync(root).sort()
const dataEntries = fs.readdirSync(dataRoot).sort()

function expectIntact(): void {
  for (const [file, bytes] of Object.entries(sentinels)) {
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `missing ${file}`).toBe(bytes)
  }
  expect(fs.readdirSync(root).sort()).toEqual(rootEntries)
  expect(fs.readdirSync(dataRoot).sort()).toEqual(dataEntries)
}

// Real source files, so a refusal can only be the id (never a missing file).
const srcDir = h.tmpDir()
const srcFile = path.join(srcDir, 'in.md')
fs.writeFileSync(srcFile, 'SRC')
const srcPng = path.join(srcDir, 'icon.png')
fs.writeFileSync(srcPng, 'PNG')
const srcTree = path.join(srcDir, 'tree')
fs.mkdirSync(srcTree)
fs.writeFileSync(path.join(srcTree, 'a.md'), 'A')

const lines: Array<{
  event: string
  outcome: string
  actor: string | null
  detail: Record<string, unknown>
}> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

type WireError = { message: string; data: { code: string; httpStatus: number; appCode?: string } }
type Principal = { userId: string; role: 'user'; scopes: ['full'] }

/** One tRPC call over the HTTP adapter. `principal` null = a hub without login. */
async function call(
  principal: Principal | null,
  procPath: string,
  input: unknown
): Promise<{ status: number; data?: unknown; error?: WireError }> {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://hub/trpc/${procPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(superjson.serialize(input))
    }),
    router: appRouter,
    createContext: () => ({
      db: h.slayDb,
      dataRoot,
      req: { socket: { remoteAddress: '198.51.100.9' } } as never,
      ...(principal ? { principal } : {})
    })
  })
  const body = (await res.json()) as {
    result?: { data: { json: unknown } }
    error?: { json: WireError }
  }
  return { status: res.status, data: body.result?.data.json, error: body.error?.json }
}

const BAD_IDS = ['..', '../..', '../../..', '/tmp', root, '%2e%2e', '', 'a/b', 'a\\b', 'a\0b']

/** Each fixed procedure, called with `bad` where its id goes. */
const PROCEDURES: Array<[string, (bad: string) => unknown]> = [
  ['artifacts.cleanupTask', (bad) => ({ taskId: bad })],
  ['task.archive', (bad) => ({ id: bad })],
  ['task.archiveMany', (bad) => ({ ids: [bad] })],
  // A valid id in the same batch is not archived: the batch is refused whole.
  ['task.archiveMany', (bad) => ({ ids: [taskB, bad] })],
  ['artifacts.create', (bad) => ({ taskId: bad, title: 'x.md', content: 'X' })],
  ['artifacts.upload', (bad) => ({ taskId: bad, sourcePath: srcFile })],
  ['artifacts.uploadBlob', (bad) => ({ taskId: bad, title: 'x.md', bytes: new Uint8Array([1]) })],
  [
    'artifacts.pasteFiles',
    (bad) => ({ sourcePaths: [srcFile], destTaskId: bad, destFolderId: null })
  ],
  ['artifacts.uploadDir', (bad) => ({ taskId: bad, dirPath: srcTree, parentFolderId: null })],
  ['projects.uploadIcon', (bad) => ({ projectId: bad, sourcePath: srcPng })]
]

const archivedAt = (id: string): unknown =>
  (h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as { archived_at: unknown })
    .archived_at
const artifactRows = (): number =>
  (h.db.prepare('SELECT COUNT(*) AS n FROM task_artifacts').get() as { n: number }).n

for (const [label, principal] of [
  ['hub without login (the desktop app)', null],
  ['hub with login (a signed-in user)', { userId: 'user-7', role: 'user', scopes: ['full'] }]
] as const) {
  await describe(`${label}: bad ids are refused, nothing on disk changes`, () => {
    test('setup', () => {
      setAuthGate(() => principal !== null)
      lines.length = 0
    })

    for (const [proc, input] of PROCEDURES) {
      test(`${proc}: BAD_REQUEST + INVALID_ID for every bad id`, async () => {
        const rowsBefore = artifactRows()
        for (const bad of BAD_IDS) {
          const res = await call(principal as Principal | null, proc, input(bad))
          if (res.error?.data.appCode !== 'INVALID_ID') {
            throw new Error(`${proc}(${JSON.stringify(bad)}) → ${JSON.stringify(res)}`)
          }
          expect(res.status).toBe(400)
          expect(res.error.data.code).toBe('BAD_REQUEST')
        }
        expect(artifactRows()).toBe(rowsBefore)
        expect(archivedAt(taskB)).toBeNull()
        expectIntact()
      })
    }

    test('each refusal wrote one denied audit line, as the caller', () => {
      expect(lines.length).toBeGreaterThanOrEqual(PROCEDURES.length * BAD_IDS.length)
      for (const l of lines) {
        expect(l.event).toBe('hub.path.refused')
        expect(l.outcome).toBe('denied')
        expect(l.actor).toBe(principal ? 'user-7' : null)
      }
    })

    test('projects.delete with an empty id removes no icon (it matched every dotfile)', async () => {
      const res = await call(principal as Principal | null, 'projects.delete', { id: '' })
      expect(res.status).toBe(200)
      expectIntact()
    })
  })
}

await describe('valid ids still work', () => {
  test('setup', () => setAuthGate(() => false))

  test('artifacts.create writes under artifacts/<taskId>/', async () => {
    const res = await call(null, 'artifacts.create', { taskId: taskA, title: 'n.md', content: 'N' })
    const created = res.data as { id: string }
    expect(
      fs.readFileSync(path.join(dataRoot, 'artifacts', taskA, `${created.id}.md`), 'utf8')
    ).toBe('N')
  })

  test('artifacts.cleanupTask removes only that task’s dir', async () => {
    const res = await call(null, 'artifacts.cleanupTask', { taskId: taskA })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(dataRoot, 'artifacts', taskA))).toBe(false)
    expectIntact()
  })

  test('task.archive archives and cleans its own artifacts only', async () => {
    fs.mkdirSync(path.join(dataRoot, 'artifacts', taskA), { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'artifacts', taskA, 'gone.md'), 'G')
    const res = await call(null, 'task.archive', { id: taskA })
    expect(res.status).toBe(200)
    expect(archivedAt(taskA)).not.toBeNull()
    expect(fs.existsSync(path.join(dataRoot, 'artifacts', taskA))).toBe(false)
    expectIntact()
  })

  test('projects.uploadIcon writes project-icons/<projectId>.png', async () => {
    const res = await call(null, 'projects.uploadIcon', { projectId: projectA, sourcePath: srcPng })
    expect(res.status).toBe(200)
    expect(fs.readFileSync(path.join(dataRoot, 'project-icons', `${projectA}.png`), 'utf8')).toBe(
      'PNG'
    )
  })
})

await describe('REST and MCP archive-many', () => {
  const app = express()
  app.use(express.json())
  registerArchiveManyTaskRoute(app, {
    db: h.slayDb,
    notifyRenderer: () => undefined
  } as unknown as RestApiDeps)
  let tool:
    | ((args: {
        ids: string[]
      }) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>)
    | null = null
  registerArchiveManyTaskTool(
    { tool: (...args: unknown[]) => (tool = args[3] as typeof tool) } as never,
    { db: h.slayDb, notifyRenderer: () => undefined }
  )

  test('POST /api/tasks/archive-many: 400 { code: INVALID_ID } for every bad id', async () => {
    const rest = await mountRestApp(app)
    try {
      for (const bad of BAD_IDS) {
        const res = await rest.request<{ ok: boolean; code: string }>(
          'POST',
          '/api/tasks/archive-many',
          { ids: [taskB, bad] }
        )
        expect(res.status).toBe(400)
        expect(res.body.ok).toBe(false)
        expect(res.body.code).toBe('INVALID_ID')
      }
    } finally {
      await rest.close()
    }
    expect(archivedAt(taskB)).toBeNull()
    expectIntact()
  })

  test('MCP archive_many_task: isError for every bad id', async () => {
    for (const bad of BAD_IDS) {
      const res = await tool!({ ids: [bad] })
      expect(res.isError).toBe(true)
      expect(res.content[0].text.startsWith('Invalid taskId')).toBe(true)
    }
    expect(archivedAt(taskB)).toBeNull()
    expectIntact()
  })
})

await describe('names that are not ids stay inside their base too', () => {
  test('a folder download refuses a title that climbs out of the chosen dir', async () => {
    const store = createArtifactStore(dataRoot)
    const dest = path.join(h.tmpDir(), 'dest')
    fs.mkdirSync(dest)
    const host = {
      showOpenDialog: async () => ({ canceled: false, filePaths: [dest] })
    } as unknown as ArtifactDownloadHost

    const ok = await store.createFolder(h.slayDb, { taskId: taskB, name: 'docs' })
    await store.createArtifact(h.slayDb, {
      taskId: taskB,
      folderId: ok!.id,
      title: 'a.md',
      content: 'A'
    })
    expect(await downloadArtifactFolder(host, h.slayDb, dataRoot, ok!.id)).toBe(true)
    expect(fs.readFileSync(path.join(dest, 'docs', 'a.md'), 'utf8')).toBe('A')

    const evil = await store.createFolder(h.slayDb, { taskId: taskB, name: 'evil' })
    await store.createArtifact(h.slayDb, {
      taskId: taskB,
      folderId: evil!.id,
      title: '../../escape.md',
      content: 'E'
    })
    let code: unknown
    try {
      await downloadArtifactFolder(host, h.slayDb, dataRoot, evil!.id)
    } catch (err) {
      code = (err as { code?: unknown }).code
    }
    expect(code).toBe('PATH_OUTSIDE_BASE')
    expect(fs.existsSync(path.join(path.dirname(dest), 'escape.md'))).toBe(false)
  })

  test('the blob store cannot name a path outside blobs/', () => {
    const blobs = new BlobStore(dataRoot)
    for (const hash of ['../../x', '..', '']) {
      let code: unknown
      try {
        blobs.delete(hash)
      } catch (err) {
        code = (err as { code?: unknown }).code
      }
      expect(code).toBe('PATH_OUTSIDE_BASE')
    }
    expectIntact()
  })
})
