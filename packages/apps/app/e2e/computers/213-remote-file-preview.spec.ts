import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect, type ElectronApplication } from '@playwright/test'
import { bootConfigPath, launchIsolatedElectron } from '../fixtures/electron'
import {
  attachComputerToHub,
  authorizeHubInApp,
  spawnSecondHub,
  waitForHubHealth,
  withHubClient,
  type HubComputer,
  type SecondHub
} from '../fixtures/second-hub'
import { toArtifactFileUrl, toSlzSourceUrl } from '@slayzone/platform/slz-file-url'

/**
 * Previews of files that live on a REMOTE hub (its artifacts) or on one of its
 * computers (a project checkout). Those paths are another machine's, so the desktop
 * must never look for them on its own disk — it used to, and answered "Access denied
 * — Path outside home directory". Everything here sits outside the home directory
 * (os.tmpdir()), which is what made the old handler refuse it.
 *
 * The handler is driven through the app's own session (`session.fetch` runs the
 * registered `slz-file` protocol handler), exactly as an iframe or <img> would.
 */

type Fetched = { status: number; type: string | null; range: string | null; text: string }

function slzFetch(app: ElectronApplication, url: string, range?: string): Promise<Fetched> {
  return app.evaluate(
    async ({ session }, { url, range }) => {
      const res = await session.defaultSession.fetch(url, {
        headers: range ? { range } : {}
      })
      return {
        status: res.status,
        type: res.headers.get('content-type'),
        range: res.headers.get('content-range'),
        text: await res.text()
      }
    },
    { url, range }
  )
}

const HUB_ID = 'remote-b'
const PAGE =
  '<html><head><link rel="stylesheet" href="css/site.css"></head><body>remote page</body></html>'

base.describe('previews of files on a remote hub', () => {
  let store: string
  let hub: SecondHub | null = null
  let computer: HubComputer | null = null
  let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
  let root: string
  let projectId: string
  let artifact: { id: string; path: string }

  base.beforeAll(async () => {
    base.setTimeout(240_000)
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-e2e-remote-preview-'))
    hub = await spawnSecondHub(store)
    await waitForHubHealth(hub.port)
    const allowedRoot = path.join(store, 'roots')
    computer = await attachComputerToHub(hub, {
      storeDir: store,
      name: 'remote-computer',
      allowedRoot
    })
    root = path.join(allowedRoot, 'project')
    fs.mkdirSync(path.join(root, 'site', 'css'), { recursive: true })
    fs.writeFileSync(path.join(root, 'site', 'index.html'), PAGE)
    fs.writeFileSync(path.join(root, 'site', 'css', 'site.css'), 'body{color:red}')
    fs.writeFileSync(path.join(root, 'digits.txt'), '0123456789')

    const created = await withHubClient(hub, async (c) => {
      const project = (await c.projects.create.mutate({
        name: 'Remote previews',
        color: '#2563eb',
        path: root,
        computerId: computer!.computerId
      })) as { id: string }
      const task = (await c.task.create.mutate({
        projectId: project.id,
        title: 'Remote preview task',
        status: 'todo'
      })) as { id: string }
      const a = (await c.artifacts.uploadBlob.mutate({
        taskId: task.id,
        title: 'report.html',
        bytes: new TextEncoder().encode('<html><head></head><body>remote artifact</body></html>')
      })) as { id: string }
      const p = (await c.artifacts.getFilePath.query({ id: a.id })) as string
      return { projectId: project.id, artifact: { id: a.id, path: p } }
    })
    projectId = created.projectId
    artifact = created.artifact

    const hubUrl = hub.url
    launched = await launchIsolatedElectron({
      name: 'remote-file-preview',
      seedUserData: (userDataDir) => {
        fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
        fs.writeFileSync(
          bootConfigPath(userDataDir),
          JSON.stringify({
            server_mode: 'local',
            multi_hub: true,
            hubs: [{ id: HUB_ID, kind: 'remote', label: 'Hub B', url: hubUrl }],
            default_hub_id: 'local'
          })
        )
      },
      extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
    })
    await launched.page.waitForSelector('#root', { timeout: 20_000 })
    await authorizeHubInApp(launched.page, HUB_ID, hub.token)
  })

  base.afterAll(async () => {
    if (launched) await launched.close()
    if (computer) await computer.stop()
    if (hub) await hub.stop()
    fs.rmSync(store, { recursive: true, force: true })
  })

  const workspace = () => ({
    kind: 'workspace' as const,
    hubId: HUB_ID,
    rootPath: root,
    projectId
  })

  base('an HTML artifact previews, themed, from the hub that keeps it', async () => {
    const res = await slzFetch(
      launched!.app,
      toArtifactFileUrl(HUB_ID, artifact.id, artifact.path, 1, 'dark')
    )
    expect(res.text).not.toContain('Access denied')
    expect(res.status).toBe(200)
    // The page declares no charset: decoded as UTF-8, not windows-1252.
    expect(res.type).toBe('text/html; charset=utf-8')
    expect(res.text).toContain('remote artifact')
    // The forced theme is injected into the page, as for a local artifact.
    expect(res.text.length).toBeGreaterThan(
      '<html><head></head><body>remote artifact</body></html>'.length
    )
  })

  base('an HTML page in a remote checkout previews, with its relative stylesheet', async () => {
    const pageUrl = toSlzSourceUrl(workspace(), 'site/index.html')
    const page = await slzFetch(launched!.app, pageUrl)
    expect(page.text).not.toContain('Access denied')
    expect(page.type).toBe('text/html; charset=utf-8')
    expect(page.text).toBe(PAGE)

    // The browser resolves `css/site.css` against the page URL: same source.
    const cssUrl = new URL('css/site.css', pageUrl).href
    const css = await slzFetch(launched!.app, cssUrl)
    expect(css.type).toBe('text/css')
    expect(css.text).toBe('body{color:red}')
  })

  base('a ranged read (PDF, media) gets just that range', async () => {
    const res = await slzFetch(
      launched!.app,
      toSlzSourceUrl(workspace(), 'digits.txt'),
      'bytes=2-4'
    )
    expect(res.status).toBe(206)
    expect(res.range).toBe('bytes 2-4/10')
    expect(res.text).toBe('234')
  })

  base('a missing remote file says so', async () => {
    const res = await slzFetch(launched!.app, toSlzSourceUrl(workspace(), 'nope.png'))
    expect(res.text).toContain('File not found')
  })
})
