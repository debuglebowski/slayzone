import { createHash, randomBytes } from 'crypto'
import fs from 'fs'
import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

/**
 * Selecting a large or binary artifact must not freeze the app, or rewrite the file.
 *
 * Repro 2026-11-15 (before the fix): an unknown extension falls back to markdown, so
 * a 4 MB binary was read whole as UTF-8 into the rich-text editor — a 19 s
 * main-thread block, and ONE keystroke autosaved the decoded text over it
 * (4 MB → 7.7 MB). Markdown itself: 0.5 MB blocked 6.4 s, 2 MB crashed the renderer.
 * The code view was fine at 20 MB.
 */

/** Longest single main-thread block allowed while opening an artifact. */
const MAX_BLOCK_MS = 500
const MB = 1024 * 1024

const PANELS_WITH_ARTIFACTS = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  artifacts: true,
  processes: false
}

const panel = (page: Page) => page.locator('[data-panel-id="artifacts"]:visible')
const row = (page: Page, title: string) =>
  panel(page)
    .locator('[data-testid="artifacts-sidebar"] [data-testid^="artifact-row-"]')
    .filter({ has: page.locator('span', { hasText: title }) })
    .first()
const noPreview = (page: Page) => panel(page).locator('[data-testid="artifact-no-preview"]')

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const filePathOf = (page: Page, id: string) =>
  page.evaluate(
    (artifactId) => window.getTrpcVanillaClient().artifacts.getFilePath.query({ id: artifactId }),
    id
  )

const startJankProbe = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __jank: { tasks: number[]; obs?: PerformanceObserver } }
    w.__jank?.obs?.disconnect()
    w.__jank = { tasks: [] }
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__jank.tasks.push(Math.round(e.duration))
    })
    obs.observe({ type: 'longtask' })
    w.__jank.obs = obs
  })

/** Longest main-thread block since startJankProbe (0 = none over 50 ms). */
const stopJankProbe = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __jank: { tasks: number[]; obs?: PerformanceObserver } }
    w.__jank.obs?.disconnect()
    return w.__jank.tasks.length ? Math.max(...w.__jank.tasks) : 0
  })

/** Builds text of at least `bytes` bytes from repeated chunks. */
function repeatTo(bytes: number, chunk: (i: number) => string): Buffer {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const c = chunk(i)
    parts.push(c)
    size += c.length
  }
  return Buffer.from(parts.join(''), 'utf8')
}

const logLine = (i: number) =>
  `2026-11-15T10:00:00.${String(i % 1000).padStart(3, '0')}Z INFO req id=${i} path=/api/tasks/${i % 977} status=200 dur=${i % 97}ms\n`
// A report-shaped markdown doc: a heading per ~1.3 KB of prose, lists, inline marks.
const sentence = (i: number) =>
  `Paragraph ${i} has some **bold** text, a [link](https://example.com/${i}), and \`inline code\` to parse. `
const mdSection = (i: number) =>
  `## Section ${i}\n\n${sentence(i).repeat(6)}\n\n${sentence(i + 1).repeat(4)}\n\n- item a\n- item b with *emphasis*\n- item c\n\n`

test.describe('Large artifact selection', () => {
  let taskId = ''

  /** A new artifact whose working file holds `bytes`, written the way an agent would. */
  async function artifactWithBytes(page: Page, title: string, bytes: Buffer): Promise<string> {
    const s = seed(page)
    const a = await s.createArtifact({ taskId, title, content: 'x' })
    if (!a) throw new Error(`seed returned no artifact ${title}`)
    const p = await filePathOf(page, a.id)
    if (!p) throw new Error(`no file path for ${title}`)
    fs.writeFileSync(p, bytes)
    await expect(row(page, title)).toBeVisible({ timeout: 10_000 })
    return p
  }

  /**
   * Click the artifact's row; the longest main-thread block until `shown` + 2 s.
   * SZ_PROFILE_DIR=<dir> also writes a CPU profile of it (diagnosis only).
   */
  async function open(page: Page, title: string, shown: ReturnType<Page['locator']>) {
    const profileDir = process.env.SZ_PROFILE_DIR
    const cdp = profileDir ? await page.context().newCDPSession(page) : null
    if (cdp) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.start')
    }
    await startJankProbe(page)
    await row(page, title).click()
    await expect(shown).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(2_000)
    const block = await stopJankProbe(page)
    if (cdp && profileDir) {
      const { profile } = await cdp.send('Profiler.stop')
      fs.writeFileSync(`${profileDir}/${title}.cpuprofile`, JSON.stringify(profile))
    }
    return block
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Large Art',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    taskId = (await s.createTask({ projectId: p.id, title: 'Large artifacts', status: 'todo' })).id
    const small = await s.createArtifact({ taskId, title: 'small.md', content: '# small\n' })
    if (!small) throw new Error('seed returned no artifact')
    await s.updateTask({
      id: taskId,
      panelVisibility: PANELS_WITH_ARTIFACTS,
      activeArtifactId: small.id
    })
    await s.refreshData()
    await openTaskById(mainWindow, taskId)
    await expect(panel(mainWindow).locator('.ProseMirror').first()).toBeVisible({
      timeout: 10_000
    })
  })

  test('a 4 MB binary shows No preview, without a freeze, and is never rewritten', async ({
    mainWindow
  }) => {
    test.setTimeout(120_000)
    const bytes = randomBytes(4 * MB)
    const p = await artifactWithBytes(mainWindow, 'blob.bin', bytes)

    const block = await open(mainWindow, 'blob.bin', noPreview(mainWindow))
    expect(block, 'longest main-thread block (ms)').toBeLessThan(MAX_BLOCK_MS)
    await expect(noPreview(mainWindow)).toHaveAttribute('data-reason', 'binary')
    await expect(panel(mainWindow).locator('.ProseMirror, .cm-editor')).toHaveCount(0)
    await expect(noPreview(mainWindow).getByRole('button', { name: /download/i })).toBeVisible()

    // Keys pressed at the panel reach no editor; nothing autosaves.
    await noPreview(mainWindow).click()
    await mainWindow.keyboard.type('a')
    await mainWindow.waitForTimeout(1_500)
    expect(sha(fs.readFileSync(p)), 'file bytes unchanged').toBe(sha(bytes))
  })

  test('a file over the size cap is not opened', async ({ mainWindow }) => {
    test.setTimeout(120_000)
    await artifactWithBytes(mainWindow, 'huge.log', Buffer.alloc(65 * MB, 'a'))
    const block = await open(mainWindow, 'huge.log', noPreview(mainWindow))
    expect(block, 'longest main-thread block (ms)').toBeLessThan(MAX_BLOCK_MS)
    await expect(noPreview(mainWindow)).toHaveAttribute('data-reason', 'too-large')
  })

  test('a 2 MB markdown file opens as source with a notice, without a freeze', async ({
    mainWindow
  }) => {
    test.setTimeout(120_000)
    await artifactWithBytes(mainWindow, 'big.md', repeatTo(2 * MB, mdSection))
    const block = await open(
      mainWindow,
      'big.md',
      panel(mainWindow).locator('[data-testid="artifact-large-doc-notice"]')
    )
    expect(block, 'longest main-thread block (ms)').toBeLessThan(MAX_BLOCK_MS)
    await expect(panel(mainWindow).locator('.cm-editor').first()).toBeVisible()
    await expect(panel(mainWindow).locator('.ProseMirror')).toHaveCount(0)
  })

  test('a 20 MB log opens in the code view and types without a freeze', async ({ mainWindow }) => {
    test.setTimeout(120_000)
    await artifactWithBytes(mainWindow, 'big.log', repeatTo(20 * MB, logLine))
    const editor = panel(mainWindow).locator('.cm-editor').first()
    const block = await open(mainWindow, 'big.log', editor)
    expect(block, 'longest main-thread block on open (ms)').toBeLessThan(MAX_BLOCK_MS)

    await startJankProbe(mainWindow)
    await editor.locator('.cm-content').click({ position: { x: 5, y: 5 } })
    await mainWindow.keyboard.type('abc')
    await mainWindow.waitForTimeout(3_000)
    expect(
      await stopJankProbe(mainWindow),
      'longest main-thread block while typing + autosave (ms)'
    ).toBeLessThan(MAX_BLOCK_MS)
  })

  test('a 5 MB one-line JSON file opens in the code view without a freeze', async ({
    mainWindow
  }) => {
    test.setTimeout(120_000)
    const items: string[] = []
    for (let i = 0, size = 0; size < 5 * MB; i++) {
      const item = `{"id":${i},"name":"item-${i}","tags":["a","b"],"ok":true}`
      items.push(item)
      size += item.length + 1
    }
    await artifactWithBytes(mainWindow, 'min.json', Buffer.from(`[${items.join(',')}]`, 'utf8'))
    const editor = panel(mainWindow).locator('.cm-editor').first()
    const block = await open(mainWindow, 'min.json', editor)
    expect(block, 'longest main-thread block on open (ms)').toBeLessThan(MAX_BLOCK_MS)

    await startJankProbe(mainWindow)
    await editor.locator('.cm-content').click({ position: { x: 5, y: 5 } })
    await mainWindow.keyboard.type('abc')
    await mainWindow.waitForTimeout(3_000)
    expect(
      await stopJankProbe(mainWindow),
      'longest main-thread block while typing + autosave (ms)'
    ).toBeLessThan(MAX_BLOCK_MS)
  })
})
