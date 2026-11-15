/**
 * Every REST route that reaches a computer answers a refused oversized frame
 * (`frameTooLarge`) as 413 `COMPUTER_FRAME_TOO_LARGE` — never an opaque 500/503/400.
 *
 * Three layers, one guarantee:
 *  - routes with no try/catch: the JSON error middleware after `registerRestApi`;
 *  - routes that catch and answer themselves: each catch maps it first — asserted
 *    statically over every computer-backed route file (a new catch that forgets it
 *    fails here), and behaviourally for the artifact routes (the biggest replies).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/computer-frame-limit-routes.test.ts
 */
import { afterAll, describe, expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import express from 'express'
import { COMPUTER_FRAME_TOO_LARGE_RPC_CODE } from '@slayzone/platform/computer-frame-limit'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../shared/test-utils/rest-harness.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-frame-limit-routes-'))
process.env.SLAYZONE_ROOT = tmpRoot

const { computerErrorMiddleware } = await import('./computer-frame-limit.js')
const { getArtifactsDataRoot } = await import('./artifacts/shared.js')
const { setArtifactStorage } = await import('@slayzone/task-artifacts/server')
const { registerArtifactsContentRoutes } = await import('./artifacts/content.js')
const { registerArtifactsCrudRoutes } = await import('./artifacts/crud.js')
const { registerArtifactsListRoute } = await import('./artifacts/list.js')
const { registerArtifactsSearchRoute } = await import('./artifacts/search.js')
const { registerArtifactsVersionsRoutes } = await import('./artifacts/versions.js')

const MESSAGE = "reply to 'chat.request' is 211812345 bytes; the frame limit is 104857600 bytes"
const frameTooLarge = (): Error =>
  Object.assign(new Error(MESSAGE), { name: 'RpcError', code: COMPUTER_FRAME_TOO_LARGE_RPC_CODE })

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const close of closers) await close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('routes without their own catch: the JSON error middleware', () => {
  test('an async throw of frameTooLarge is 413; anything else keeps the default 500', async () => {
    const app = express()
    app.get('/frame', async () => {
      throw frameTooLarge()
    })
    app.get('/other', async () => {
      throw new Error('boom')
    })
    app.use(computerErrorMiddleware)
    const rest = await mountRestApp(app)
    closers.push(() => rest.close())
    const frame = await rest.request('GET', '/frame')
    expect(frame.status).toBe(413)
    expect(frame.body).toEqual({ ok: false, error: MESSAGE, code: 'COMPUTER_FRAME_TOO_LARGE' })
    expect((await rest.request('GET', '/other')).status).toBe(500)
  })
})

describe('artifact routes (computer-held artifacts: the largest replies)', async () => {
  const h = await createTestHarness()
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
    .run(projectId, 'Alpha', '#000', '/tmp/alpha')
  const taskId = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(taskId, projectId, 'T', 'todo', 3, 0)
  const artifactId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO task_artifacts (id, task_id, title, "order") VALUES (?, ?, ?, ?)')
    .run(artifactId, taskId, 'big.bin', 0)

  // The hub's computer-backed store answers a too-large reply by throwing it.
  const throwing = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === 'then'
          ? undefined
          : async () => {
              throw frameTooLarge()
            }
    }
  )
  setArtifactStorage(getArtifactsDataRoot(), throwing as never)

  const app = express()
  app.use(express.json())
  const deps = { db: h.slayDb, notifyRenderer: () => {} }
  // Same order as registerRestApi: search before .
  registerArtifactsSearchRoute(app, deps)
  registerArtifactsContentRoutes(app, deps)
  registerArtifactsCrudRoutes(app, deps)
  registerArtifactsListRoute(app, deps)
  registerArtifactsVersionsRoutes(app, deps)
  app.use(computerErrorMiddleware)
  const rest = await mountRestApp(app)
  closers.push(() => rest.close())

  test.each([
    ['GET', `/api/artifacts/${artifactId}/content`],
    ['GET', `/api/artifacts/${artifactId}`],
    ['GET', `/api/tasks/${taskId}/artifacts`],
    ['GET', `/api/artifacts/search?q=x&taskId=${taskId}`],
    ['GET', `/api/artifacts/${artifactId}/versions`],
    ['GET', `/api/artifacts/${artifactId}/versions/content?ref=current`]
  ])('%s %s → 413 COMPUTER_FRAME_TOO_LARGE', async (method, url) => {
    const r = await rest.request(method, url)
    expect(r.status).toBe(413)
    expect(r.body).toMatchObject({ ok: false, code: 'COMPUTER_FRAME_TOO_LARGE' })
  })
})

/**
 * The route files whose handlers reach a computer (artifact store, workspace fs,
 * pty buffers, task folder/worktree ops, project folders, task moves).
 */
const COMPUTER_BACKED_ROUTE_FILES = [
  'artifacts/content.ts',
  'artifacts/crud.ts',
  'artifacts/versions.ts',
  'artifacts/list.ts',
  'artifacts/search.ts',
  'artifacts/export-pdf.ts',
  'artifacts/export-png.ts',
  'files/raw.ts',
  'pty/buffer.ts',
  'tasks/create.ts',
  'tasks/update.ts',
  'tasks/get.ts',
  'tasks/reset-conversation.ts',
  'tasks/archive.ts',
  'tasks/delete.ts',
  'tasks/done.ts',
  'tasks/archive-many.ts',
  'tasks/unarchive.ts',
  'projects/crud.ts',
  'projects/skills.ts',
  'transfers.ts',
  'chat/_chat.ts'
]

/** Bodies of every `catch (…) { … }` statement in `source`. */
function catchBodies(source: string): string[] {
  const bodies: string[] = []
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
    }
    bodies.push(source.slice(m.index + m[0].length, i - 1))
  }
  return bodies
}

/** Helpers that map frameTooLarge themselves (each asserted below). */
const MAPPING_HELPERS = ['sendError(', 'classify(', 'sendChatError(']

describe('every catch in a computer-backed route maps frameTooLarge first', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname)
  test.each(COMPUTER_BACKED_ROUTE_FILES)('%s', (file) => {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    const answering = catchBodies(source).filter((body) => /\.status\(|\bfail\(/.test(body))
    for (const body of answering) {
      const mapped =
        body.includes('respondFrameTooLarge(') || MAPPING_HELPERS.some((h) => body.includes(h))
      expect(mapped, `a catch in ${file} answers without mapping frameTooLarge:\n${body}`).toBe(
        true
      )
    }
  })

  test('the shared mappers handle it', () => {
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8')
    expect(read('artifacts/versions.ts')).toMatch(
      /function sendError[\s\S]*?respondFrameTooLarge\(res, err\)/
    )
    expect(read('files/raw.ts')).toMatch(/function classify[\s\S]*?isComputerFrameTooLarge\(err\)/)
    expect(read('chat/_chat.ts')).toMatch(/respondFrameTooLarge\(res, err\)/)
  })

  test('the REST app mounts the error middleware after the routes', () => {
    const server = fs.readFileSync(path.join(dir, '..', 'mcp-server.ts'), 'utf8')
    expect(server).toMatch(/registerRestApi\(app, deps\)[\s\S]*app\.use\(computerErrorMiddleware\)/)
  })
})
