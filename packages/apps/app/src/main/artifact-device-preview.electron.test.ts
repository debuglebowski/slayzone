/**
 * Artifact device previews in a REAL Electron: a host window with the preview
 * `<webview>`, driven through the host's own input path (CDP Input.dispatchMouseEvent
 * on the host goes through the window's input router, like a real mouse).
 *
 * Chromium keeps ONE touch emulator per window: CDP `Emulation.setEmitTouchEventsForMouse`
 * sent to a `<webview>` guest turned the whole SlayZone window into touch mode (touch
 * cursor, mouse → touch everywhere) and it survived the guest and a reload.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/app/src/main/artifact-device-preview.electron.test.ts
 */
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { type BuildOptions, build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { toHtmlArtifactPreviewUrl } from '@slayzone/platform/slz-file-url'

const require = createRequire(import.meta.url)
const ELECTRON_BIN = require('electron') as unknown as string
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-device-preview-electron-'))
const mainBundle = path.join(tmp, 'artifact-device-preview.cjs')
const preloadBundle = path.join(tmp, 'artifact-device-preview-preload.js')
const driver = path.join(tmp, 'driver.cjs')

type Events = string[]
interface RunResult {
  hostMobile: Events
  guestTapMobile: Events
  guestScrollMobile: number
  guestTapDesktop: Events
  hostDesktop: Events
  hostAfterGuestGone: Events
  zoomedDesktop: [number, number, number]
  zoomedMobile: [number, number, number]
  outOfRangeZoom: boolean
  /** How long after load the guest started taking input (diagnostic). */
  routedAfterMs: number
}

const DRIVER = `
const { app, BrowserWindow, protocol } = require('electron')
const { createArtifactDevicePreviews } = require(${JSON.stringify(mainBundle)})
const { ARTIFACT_DEVICE_PARTITION, URL: ARTIFACT_URL } = JSON.parse(process.env.SLZ_TEST_CONFIG)
protocol.registerSchemesAsPrivileged([
  { scheme: 'slz-artifact', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
const LOGGER = "window.log=[];for(const e of ['mousedown','touchstart','pointerdown','click'])" +
  "addEventListener(e,ev=>log.push(e+':'+(ev.pointerType||'')),true)"
const GUEST = '<!doctype html><meta name="viewport" content="width=device-width">' +
  '<body style="margin:0;height:4000px"><script>' + LOGGER + '</script></body>'
const HOST = '<body style="margin:0"><div style="width:400px;height:400px"></div>' +
  '<webview partition="' + ARTIFACT_DEVICE_PARTITION + '" src="about:blank" ' +
  'style="position:absolute;left:500px;top:0;width:300px;height:500px"></webview>' +
  '<script>' + LOGGER + ";window.moves=0;addEventListener('mousemove',()=>moves++,true)</script></body>"
const MOBILE = { width: 300, height: 500, angle: 0, deviceScaleFactor: 3, mobile: true }
const DESKTOP = { ...MOBILE, deviceScaleFactor: 1, mobile: false }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.on('window-all-closed', () => {})
app.dock && app.dock.hide()
app.whenReady().then(async () => {
  const previews = createArtifactDevicePreviews(
    async () => new Response(GUEST, { headers: { 'content-type': 'text/html' } }),
    ${JSON.stringify(preloadBundle)}
  )
  const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { webviewTag: true } })
  // On X11 a hidden (unmapped) window is barely drawn: a mouse move into the guest
  // waits ~1 s for its ack (~20 ms once mapped), and on CI clicks at the preview kept
  // landing on the host page, for one tap or the whole run. The app's window is
  // mapped; map this one too (inactive: no focus steal; under xvfb-run no one sees
  // it). macOS hidden windows take input at full speed.
  if (process.platform === 'linux') win.showInactive()
  const wc = win.webContents
  wc.on('will-attach-webview', (event, prefs, params) => {
    if (!previews.prepare(prefs, params.src)) event.preventDefault()
  })
  const guestP = new Promise((r) => wc.on('did-attach-webview', (_e, guest) => {
    previews.attach(wc, guest)
    r(guest)
  }))
  await wc.loadURL('data:text/html,' + encodeURIComponent(HOST))
  const guest = await guestP
  const loaded = new Promise((r) => guest.once('did-finish-load', r))
  if (!(await previews.configure(wc, guest.id, ARTIFACT_URL, MOBILE, 1))) throw new Error('configure failed')
  await loaded
  const cdp = wc.debugger
  cdp.attach()
  const dispatch = (params) =>
    cdp.sendCommand('Input.dispatchMouseEvent', { button: 'left', clickCount: 1, ...params })
  // A converted mouse event's CDP ack can hang; never let it stall the run.
  const mouse = (params) => Promise.race([dispatch(params).catch(() => {}), sleep(800)])
  // Input at the preview goes to the host page until the compositor routes that spot to
  // the guest: measured 0.1-0.5 s after load (mapped; past 1.5 s hidden on X11), so a
  // fixed sleep loses on a slow runner. Move the mouse onto the preview until the host
  // page no longer sees the move; only an acked move counts (the ack comes once the page
  // under it handled it). Neither the preload nor the logs act on a buttonless move.
  const guestTakesInput = async () => {
    await mouse({ type: 'mouseMoved', x: 100, y: 100, button: 'none' })
    await wc.executeJavaScript('moves = 0')
    const acked = await Promise.race([
      dispatch({ type: 'mouseMoved', x: 550, y: 50, button: 'none' }).then(() => true, () => false),
      sleep(800).then(() => false)
    ])
    return acked && (await wc.executeJavaScript('moves === 0'))
  }
  const routeStart = Date.now()
  while (!(await guestTakesInput()) && Date.now() - routeStart < 15000) await sleep(50)
  const routedAfterMs = Date.now() - routeStart
  const click = async (x, y) => {
    await mouse({ type: 'mouseMoved', x, y, button: 'none' })
    await mouse({ type: 'mousePressed', x, y, buttons: 1 })
    await mouse({ type: 'mouseReleased', x, y, buttons: 0 })
    await sleep(300)
  }
  // A forwarded tap reaches the guest asynchronously (preload -> IPC -> main -> CDP), so
  // wait for the condition (bounded) instead of a fixed sleep a slow runner outlasts.
  const settle = (contents, cond) => contents.executeJavaScript(
    'new Promise((r) => { const t0 = Date.now(); (function f() {' +
    ' if ((' + cond + ') || Date.now() - t0 > 5000) r(); else setTimeout(f, 25) })() })'
  )
  // Every click ends in a click event; take the log once it is there.
  const drain = async (contents) => {
    await settle(contents, "log.some((e) => e.startsWith('click:'))")
    return contents.executeJavaScript('log.splice(0)')
  }
  const out = { routedAfterMs }
  await click(100, 100)
  out.hostMobile = await drain(wc)
  await click(550, 50)
  out.guestTapMobile = await drain(guest)
  await mouse({ type: 'mouseMoved', x: 550, y: 450, button: 'none' })
  await mouse({ type: 'mousePressed', x: 550, y: 450, buttons: 1 })
  for (let y = 430; y >= 50; y -= 20) await mouse({ type: 'mouseMoved', x: 550, y, buttons: 1 })
  await mouse({ type: 'mouseReleased', x: 550, y: 50, buttons: 0 })
  await settle(guest, 'scrollY > 100')
  await sleep(300)
  out.guestScrollMobile = await guest.executeJavaScript('scrollY')
  await guest.executeJavaScript('log.splice(0)')
  await previews.configure(wc, guest.id, ARTIFACT_URL, DESKTOP, 1)
  await sleep(200)
  await click(550, 50)
  out.guestTapDesktop = await drain(guest)
  await click(100, 100)
  out.hostDesktop = await drain(wc)
  const metrics = () => guest.executeJavaScript('[innerWidth, innerHeight, devicePixelRatio]')
  await previews.configure(wc, guest.id, ARTIFACT_URL, DESKTOP, 1.5)
  await sleep(200)
  out.zoomedDesktop = await metrics()
  await previews.configure(wc, guest.id, ARTIFACT_URL, MOBILE, 1.5)
  await sleep(200)
  out.zoomedMobile = await metrics()
  out.outOfRangeZoom = await previews.configure(wc, guest.id, ARTIFACT_URL, MOBILE, 50)
  await previews.configure(wc, guest.id, ARTIFACT_URL, MOBILE, 1)
  await sleep(200)
  await wc.executeJavaScript("document.querySelector('webview').remove()")
  await sleep(500)
  await click(100, 100)
  out.hostAfterGuestGone = await drain(wc)
  process.stdout.write('SLZ_RESULT ' + JSON.stringify(out) + '\\n')
  app.exit(0)
}).catch((err) => {
  process.stdout.write('SLZ_ERROR ' + String(err && err.stack) + '\\n')
  app.exit(1)
})
`

/**
 * Linux launch. `--no-sandbox` as in artifact-export.electron.test.ts. No display
 * (the CI runner): run under `xvfb-run`, NOT `--ozone-platform=headless` — headless
 * ozone routes no mouse input into a `<webview>` guest at all (every click at the
 * preview, desktop viewport included, lands on the host page), so the test would
 * measure nothing. Under X11 (Xvfb) the routing and the touch replay work as on macOS.
 */
function hasDisplay(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

function onPath(bin: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, bin)))
}

const NEEDS_XVFB = process.platform === 'linux' && !hasDisplay()
const CANT_RUN = process.platform === 'win32' || (NEEDS_XVFB && !onPath('xvfb-run'))

function launchCommand(args: string[]): [string, string[]] {
  if (process.platform !== 'linux') return [ELECTRON_BIN, args]
  const helper = path.join(path.dirname(ELECTRON_BIN), 'chrome-sandbox')
  const st = fs.statSync(helper, { throwIfNoEntry: false })
  if (!st || st.uid !== 0 || (st.mode & 0o4000) === 0) args = ['--no-sandbox', ...args]
  return NEEDS_XVFB ? ['xvfb-run', ['-a', ELECTRON_BIN, ...args]] : [ELECTRON_BIN, args]
}

let child: ChildProcess | null = null

/** Kills xvfb-run's Xvfb and Electron too: the run is its own process group. */
function kill(p: ChildProcess) {
  if (p.pid === undefined) return
  try {
    process.kill(-p.pid, 'SIGKILL')
  } catch {
    p.kill('SIGKILL')
  }
}

function run(config: Record<string, string>, budgetMs = 90_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SLZ_TEST_CONFIG: JSON.stringify(config) }
    delete env.ELECTRON_RUN_AS_NODE
    const [command, args] = launchCommand([driver, `--user-data-dir=${path.join(tmp, 'profile')}`])
    const p = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    child = p
    let out = ''
    let err = ''
    p.stdout?.on('data', (d) => {
      out += d
    })
    p.stderr?.on('data', (d) => {
      err += d
    })
    const timer = setTimeout(() => {
      kill(p)
      reject(new Error(`Electron run exceeded ${budgetMs} ms\n${err.slice(-2000)}`))
    }, budgetMs)
    p.on('exit', () => {
      clearTimeout(timer)
      child = null
      const line = out.split('\n').find((l) => l.startsWith('SLZ_RESULT '))
      if (line) resolve(JSON.parse(line.slice('SLZ_RESULT '.length)) as RunResult)
      else reject(new Error(`no result\n${out.slice(-2000)}\n${err.slice(-2000)}`))
    })
  })
}

beforeAll(async () => {
  const common: BuildOptions = {
    bundle: true,
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  }
  await build({
    ...common,
    entryPoints: [path.join(__dirname, 'artifact-device-preview.ts')],
    platform: 'node',
    target: 'node22',
    outfile: mainBundle
  })
  // The guest preload is sandboxed: browser platform, only `electron` external.
  await build({
    ...common,
    entryPoints: [path.join(__dirname, '../preload/artifact-device-preview.ts')],
    platform: 'browser',
    outfile: preloadBundle
  })
  fs.writeFileSync(driver, DRIVER)
}, 60_000)

afterAll(() => {
  if (child) kill(child)
  fs.rmSync(tmp, { recursive: true, force: true })
})

// One driver run serves every test: launching Electron is the slow part.
let driverRunP: Promise<RunResult> | null = null
async function driverRun(): Promise<RunResult> {
  driverRunP ??= toHtmlArtifactPreviewUrl('hub-1', 'artifact-1', 'page.html').then((url) =>
    run({ ARTIFACT_DEVICE_PARTITION: 'persist:artifact-device-previews', URL: url })
  )
  return driverRunP
}

// Windows: never run here. Linux without a display needs xvfb-run (see launchCommand).
describe.skipIf(CANT_RUN)('artifact device preview in a real Electron', () => {
  test('mobile touch stays inside the preview; the host window keeps its mouse', async () => {
    const r = await driverRun()
    const detail = JSON.stringify(r)
    // The host window never turns into touch input, with a preview open or gone.
    expect(r.hostMobile, detail).toEqual(['pointerdown:mouse', 'mousedown:', 'click:mouse'])
    expect(r.hostDesktop, detail).toEqual(['pointerdown:mouse', 'mousedown:', 'click:mouse'])
    expect(r.hostAfterGuestGone, detail).toEqual(['pointerdown:mouse', 'mousedown:', 'click:mouse'])
    // A mobile preview gets a tap: touch, then the mouse events a tap is followed by.
    expect(r.guestTapMobile, detail).toEqual([
      'pointerdown:touch',
      'touchstart:',
      'mousedown:',
      'click:touch'
    ])
    // Dragging pans the page like a finger.
    expect(r.guestScrollMobile, detail).toBeGreaterThan(100)
    // A desktop preview gets the mouse.
    expect(r.guestTapDesktop, detail).toEqual(['pointerdown:mouse', 'mousedown:', 'click:mouse'])
  }, 120_000)

  test('zoom happens inside the device: smaller layout viewport, denser pixels', async () => {
    const r = await driverRun()
    const detail = JSON.stringify(r)
    // 300×500 at 150%: CSS pixels grow, as with browser zoom, on desktop and mobile alike.
    expect(r.zoomedDesktop, detail).toEqual([200, 333, 1.5])
    expect(r.zoomedMobile, detail).toEqual([200, 333, 4.5])
    expect(r.outOfRangeZoom, detail).toBe(false)
  }, 120_000)
})
