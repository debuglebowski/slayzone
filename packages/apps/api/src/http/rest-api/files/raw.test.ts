/**
 * REST: `GET /api/files/raw` — a workspace file's raw bytes, streamed from the
 * computer that owns the workspace in `fs.readBytes`-sized slices. The desktop's
 * `slz-file://` handler fetches previews (images, PDFs, HTML) through it when the
 * file lives on a computer it cannot read directly.
 *
 * The workspace fs here is the in-process one with `readBytes` instrumented — the
 * route only ever talks to the `WorkspaceFsAdapters` seam, so what it is tested
 * for is chunking, ranges, caching, error mapping and the path scope.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/files/raw.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { request as httpRequest } from 'node:http'
import express from 'express'
import {
  createLocalWorkspaceFsAdapters,
  setWorkspaceDeps,
  WORKSPACE_READ_BYTES_MAX_CHUNK,
  type WorkspaceFsAdapters
} from '@slayzone/file-editor/server'
import { currentPathScope, type WirePathScope } from '@slayzone/platform/path-scope'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { registerFilesRawRoute } from './raw.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', null)
const taskId = crypto.randomUUID()
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'RawTask', 'todo', 3, 0)

const root = fs.realpathSync(h.tmpDir())
fs.mkdirSync(path.join(root, 'img'))
const BIG = Buffer.from(
  Array.from({ length: WORKSPACE_READ_BYTES_MAX_CHUNK * 2 + 1234 }, (_, i) => (i * 31 + 7) % 256)
)
fs.writeFileSync(path.join(root, 'img', 'big.png'), BIG)
fs.writeFileSync(path.join(root, 'page.html'), '<h1>hi</h1>')
fs.writeFileSync(path.join(root, 'empty.txt'), '')

interface ReadCall {
  computerId: string | null
  offset: number
  length: number
  scope: WirePathScope | undefined
}
let calls: ReadCall[] = []
/** Replace a read's answer (`next` = the real read). */
let intercept:
  | ((call: ReadCall, next: () => ReturnType<WorkspaceFsAdapters['readBytes']>) => unknown)
  | null = null

const local = createLocalWorkspaceFsAdapters()
const routed: WorkspaceFsAdapters = {
  ...local,
  readBytes: (computerId, rootPath, filePath, offset, length) => {
    const call = { computerId, offset, length, scope: currentPathScope() }
    calls.push(call)
    const next = () => local.readBytes(computerId, rootPath, filePath, offset, length)
    return (intercept ? intercept(call, next) : next()) as ReturnType<
      WorkspaceFsAdapters['readBytes']
    >
  }
}
let resolved: unknown = null
setWorkspaceDeps({
  fs: routed,
  resolveComputer: async (target) => {
    resolved = target
    return 'computer-1'
  },
  isLocalComputer: () => false
})

const app = express()
registerFilesRawRoute(app, { db: h.slayDb, notifyRenderer: () => {} })
const rest = await mountRestApp(app)
afterAll(async () => {
  await rest.close()
})

beforeEach(() => {
  calls = []
  intercept = null
  resolved = null
})

const url = (q: Record<string, string>): string =>
  `${rest.url}/api/files/raw?${new URLSearchParams(q).toString()}`
const q = (p: string, extra: Record<string, string> = {}) =>
  url({ rootPath: root, path: p, taskId, ...extra })

describe('GET /api/files/raw — full reads', () => {
  test('streams a multi-chunk file byte-exact, pulling one slice at a time in order', async () => {
    const res = await fetch(q('img/big.png'))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BIG)
    expect(res.headers.get('content-length')).toBe(String(BIG.length))
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('etag')).toMatch(/^W\/".+"$/)
    expect(calls.map((c) => c.offset)).toEqual([
      0,
      WORKSPACE_READ_BYTES_MAX_CHUNK,
      WORKSPACE_READ_BYTES_MAX_CHUNK * 2
    ])
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(WORKSPACE_READ_BYTES_MAX_CHUNK)
  })

  test("runs on the resolved computer, inside the task's path scope", async () => {
    const res = await fetch(q('page.html'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>hi</h1>')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(resolved).toMatchObject({ taskId })
    expect(calls[0]?.computerId).toBe('computer-1')
    expect(calls[0]?.scope).toMatchObject({ kind: 'task', taskId, projectId })
  })

  test('a project scope and an explicit computer are honoured too', async () => {
    const res = await fetch(
      url({ rootPath: root, path: 'page.html', projectId, computerId: 'computer-9' })
    )
    expect(res.status).toBe(200)
    expect(resolved).toMatchObject({ projectId, computerId: 'computer-9' })
    expect(calls[0]?.scope).toMatchObject({ kind: 'project', projectId })
  })

  test('an empty file is a 200 with no body', async () => {
    const res = await fetch(q('empty.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('0')
    expect(await res.text()).toBe('')
  })
})

describe('GET /api/files/raw — ranges', () => {
  test('bytes=a-b → 206 with Content-Range, spanning a chunk boundary', async () => {
    const a = WORKSPACE_READ_BYTES_MAX_CHUNK - 10
    const b = WORKSPACE_READ_BYTES_MAX_CHUNK + 9
    const res = await fetch(q('img/big.png'), { headers: { range: `bytes=${a}-${b}` } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes ${a}-${b}/${BIG.length}`)
    expect(res.headers.get('content-length')).toBe('20')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BIG.subarray(a, b + 1))
  })

  test('bytes=a- → to the end', async () => {
    const a = BIG.length - 100
    const res = await fetch(q('img/big.png'), { headers: { range: `bytes=${a}-` } })
    expect(res.status).toBe(206)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BIG.subarray(a))
  })

  test('bytes=-n → the last n bytes; an end past the size is clamped', async () => {
    const res = await fetch(q('img/big.png'), { headers: { range: 'bytes=-5' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(
      `bytes ${BIG.length - 5}-${BIG.length - 1}/${BIG.length}`
    )
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BIG.subarray(BIG.length - 5))

    const clamped = await fetch(q('page.html'), { headers: { range: 'bytes=4-999' } })
    expect(clamped.status).toBe(206)
    expect(await clamped.text()).toBe('hi</h1>')
  })

  test('a range starting at or past the end → 416 with bytes */size', async () => {
    const res = await fetch(q('img/big.png'), { headers: { range: `bytes=${BIG.length}-` } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${BIG.length}`)
    const empty = await fetch(q('empty.txt'), { headers: { range: 'bytes=0-' } })
    expect(empty.status).toBe(416)
  })

  test('a malformed or multi-range header is ignored (full 200)', async () => {
    for (const range of ['bytes=5-2', 'bytes=0-1,4-5', 'lines=1-2']) {
      const res = await fetch(q('page.html'), { headers: { range } })
      expect(res.status, range).toBe(200)
      expect(await res.text()).toBe('<h1>hi</h1>')
    }
  })
})

describe('GET /api/files/raw — caching', () => {
  test('If-None-Match with the current ETag → 304, no body', async () => {
    const first = await fetch(q('img/big.png'))
    await first.arrayBuffer()
    const etag = first.headers.get('etag')!
    calls = []
    const res = await fetch(q('img/big.png'), { headers: { 'if-none-match': etag } })
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe(etag)
    expect(await res.text()).toBe('')
    // A revalidation costs one tiny probe, not a 256 KiB slice.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.length).toBe(1)
  })

  test('a stale ETag gets the full body', async () => {
    const res = await fetch(q('page.html'), { headers: { 'if-none-match': 'W/"nope"' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>hi</h1>')
  })
})

describe('GET /api/files/raw — errors', () => {
  test('400 without rootPath / path, or naming no task or project', async () => {
    const queries: Record<string, string>[] = [
      { path: 'page.html', taskId },
      { rootPath: root, taskId },
      { rootPath: root, path: 'page.html' },
      { rootPath: root, path: 'page.html', computerId: 'computer-1' }
    ]
    for (const query of queries) {
      const res = await fetch(url(query))
      expect(res.status, JSON.stringify(query)).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false })
    }
    expect(calls).toEqual([])
  })

  test('404 FILE_NOT_FOUND for a missing file and for a directory', async () => {
    for (const p of ['nope.png', 'img']) {
      const res = await fetch(q(p))
      expect(res.status, p).toBe(404)
      expect(await res.json()).toMatchObject({ ok: false, code: 'FILE_NOT_FOUND' })
    }
  })

  test('404 for a task this hub does not have', async () => {
    const res = await fetch(url({ rootPath: root, path: 'page.html', taskId: 'no-such-task' }))
    expect(res.status).toBe(404)
  })

  test("403 PATH_REFUSED for a path leaving the root, and for the computer's jail refusal", async () => {
    const res = await fetch(q('../../etc/hosts'))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, code: 'PATH_REFUSED' })

    intercept = () => {
      const err = Object.assign(new Error('outside allowedRoots'), { code: -32006 })
      err.name = 'RpcError'
      throw err
    }
    const jailed = await fetch(q('page.html'))
    expect(jailed.status).toBe(403)
    expect(await jailed.json()).toMatchObject({ ok: false, code: 'PATH_REFUSED' })
  })

  test('503 when the computer is offline or too old for fs.readBytes', async () => {
    intercept = () => {
      const err = Object.assign(new Error('computer not connected'), { code: -32004 })
      err.name = 'RpcError'
      throw err
    }
    const offline = await fetch(q('page.html'))
    expect(offline.status).toBe(503)
    expect(await offline.json()).toMatchObject({ ok: false, code: 'COMPUTER_OFFLINE' })

    intercept = () => {
      const err = Object.assign(new Error('older than this hub'), { code: -32601 })
      err.name = 'ComputerUpdatePendingError'
      throw err
    }
    const old = await fetch(q('page.html'))
    expect(old.status).toBe(503)
    expect(await old.json()).toMatchObject({ ok: false, code: 'COMPUTER_UPDATE_PENDING' })
  })

  test('a file that changes between slices aborts the response instead of mixing versions', async () => {
    intercept = async (call, next) => {
      const r = await next()
      return call.offset > 0 ? { ...r, mtimeMs: r.mtimeMs + 1 } : r
    }
    const res = await fetch(q('img/big.png'))
    expect(res.status).toBe(200)
    await expect(res.arrayBuffer()).rejects.toThrow()
  })

  test('a client that disconnects stops the pulling', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    intercept = async (call, next) => {
      if (call.offset > 0) await gate
      return next()
    }
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(q('img/big.png'), (res) => {
        res.once('data', () => {
          req.destroy()
          setTimeout(() => {
            release()
            resolve()
          }, 50)
        })
      })
      req.on('error', () => undefined)
      req.once('error', reject)
      req.end()
    }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 100))
    // The slice in flight when the client left finishes; no further one is asked for.
    expect(calls.length).toBeLessThanOrEqual(2)
  })
})
