/**
 * REST: POST /api/browser/screenshot hands the PNG BYTES to the requester.
 *
 * The CLI may run on another machine than the hub (a remote hub, or a CLI on a
 * computer reaching the hub through the relay): a path on the hub's disk is useless
 * there. So the route returns the image itself, and writes nothing to the hub's disk.
 */
import { afterAll, describe, expect, test } from 'vitest'
import express from 'express'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import type { BrowserAccess, RestApiDeps } from '../types.js'
import { registerBrowserScreenshotRoute } from './screenshot.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
let nextCapture: Uint8Array | null = PNG
const captured: Array<[string, string | null]> = []

const browser: BrowserAccess = {
  callerOf: () => ({ origin: 'elsewhere', principal: null }),
  isDesktopLocalHub: false,
  hasCapableClient: () => true,
  getResolvedBrowserTabId: async (_caller, _taskId, tabId) => tabId ?? 'tab-a',
  listBrowserTabs: async () => [{ tabId: 'tab-a', active: true }],
  hasBrowserTab: async () => true,
  isUsersOwnTab: async () => false,
  waitForBrowserRegistration: async () => {},
  execJs: async () => null,
  loadUrl: async () => {},
  getUrl: async () => null,
  capturePng: async (_caller, taskId, tabId) => {
    captured.push([taskId, tabId])
    return nextCapture
  }
}

const app = express()
app.use(express.json())
registerBrowserScreenshotRoute(app, {
  browser,
  db: { prepare: () => ({ get: async () => undefined }) }
} as unknown as RestApiDeps)
const h = await mountRestApp(app)
afterAll(() => h.close())

const hubShotsDir = join(tmpdir(), 'slayzone', 'browser-screenshots')
const hubShots = (): string[] => (existsSync(hubShotsDir) ? readdirSync(hubShotsDir) : [])

describe('POST /api/browser/screenshot', () => {
  test('returns the PNG as base64 and writes nothing on the hub', async () => {
    const before = hubShots()
    const res = await h.request<{ ok: boolean; pngBase64?: string; path?: string }>(
      'POST',
      '/api/browser/screenshot',
      { taskId: 't1', tabId: 'tab-b', accept: 'png-bytes' }
    )
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.path).toBeUndefined()
    expect(Buffer.from(res.body.pngBase64 ?? '', 'base64')).toEqual(Buffer.from(PNG))
    expect(captured.at(-1)).toEqual(['t1', 'tab-b'])
    expect(hubShots()).toEqual(before)
  })

  test('an empty capture is a 500', async () => {
    nextCapture = null
    const res = await h.request<{ error?: string }>('POST', '/api/browser/screenshot', {
      taskId: 't1',
      accept: 'png-bytes'
    })
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/empty/)
    nextCapture = PNG
  })

  // Version skew: a CLI from before bytes-not-paths sends no `accept` and reads `path`.
  // It must fail loudly (its error printer shows `error`, exit 1), never print
  // "undefined" as if it were a screenshot path.
  test('a CLI that does not ask for bytes gets a clear 409, and nothing is captured', async () => {
    const before = captured.length
    const res = await h.request<{ error?: string; path?: string }>(
      'POST',
      '/api/browser/screenshot',
      { taskId: 't1' }
    )
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/slay CLI is too old for this hub/)
    expect(res.body.path).toBeUndefined()
    expect(captured.length).toBe(before)
  })
})
