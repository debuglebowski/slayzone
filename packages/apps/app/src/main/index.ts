
import { app, shell, BrowserWindow, BrowserView, ipcMain, nativeTheme, session, webContents, dialog, Menu, protocol } from 'electron'
import { join, extname, normalize, sep, resolve } from 'path'
import { homedir } from 'os'
import { readFileSync, promises as fsp, existsSync, unlinkSync, symlinkSync } from 'fs'
import { electronApp, is } from '@electron-toolkit/utils'
import { registerBrowserPanel, unregisterBrowserPanel, clearBrowserRegistry } from './browser-registry'
import {
  BLOCKED_EXTERNAL_PROTOCOLS,
  inferHostScopeFromUrl,
  inferProtocolFromUrl,
  isBlockedExternalProtocolUrl,
  isEncodedDesktopHandoffUrl,
  isLoopbackHost,
  isLoopbackUrl,
  isUrlWithinHostScope,
  normalizeDesktopHostScope,
  normalizeDesktopProtocol,
  type DesktopHandoffPolicy,
} from '@slayzone/task/shared'

// Custom protocol for serving local files in browser panel webviews
// (must be registered before app ready — Chromium blocks file:// in webviews)
// External app protocols registered here so Chromium routes them through our session handler
// instead of passing them to the OS (which would launch desktop apps like Figma, Slack, etc.)
protocol.registerSchemesAsPrivileged([
  { scheme: 'slz-file', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  ...BLOCKED_EXTERNAL_PROTOCOLS.map(scheme => ({ scheme, privileges: { standard: true, secure: true } })),
])

// Use consistent app name for userData path (paired with legacy DB migration)
app.name = 'slayzone'
const isPlaywright = process.env.PLAYWRIGHT === '1'

// Enable remote debugging in dev (port 0 = OS-assigned, avoids conflicts with other dev instances)
if (is.dev && !isPlaywright) {
  app.commandLine.appendSwitch('remote-debugging-port', '0')
}
import icon from '../../resources/icon.png?asset'
import logoSolid from '../../resources/logo-solid.svg?asset'
import { getDatabase, closeDatabase, getDiagnosticsDatabase, closeDiagnosticsDatabase } from './db'
import { runMigrations } from './db/migrations'
import { normalizeProjectStatusData } from './db/status-normalization'
import { registerBackupHandlers, startAutoBackup, stopAutoBackup } from './backup'
// Domain handlers
import { registerProjectHandlers } from '@slayzone/projects/main'
import { configureTaskRuntimeAdapters, registerTaskHandlers, registerFilesHandlers } from '@slayzone/task/main'
import { registerTagHandlers } from '@slayzone/tags/main'
import { registerSettingsHandlers, registerThemeHandlers } from '@slayzone/settings/main'
import { registerPtyHandlers, registerUsageHandlers, killAllPtys, killPtysByTaskId, startIdleChecker, stopIdleChecker, dismissAllNotifications, syncTerminalModes, getPtyPids, onSessionChange } from '@slayzone/terminal/main'
import { registerTerminalTabsHandlers } from '@slayzone/task-terminals/main'
import { registerWorktreeHandlers } from '@slayzone/worktrees/main'
import { registerDiagnosticsHandlers, registerProcessDiagnostics, recordDiagnosticEvent, stopDiagnostics, setIpcSuccessHook } from '@slayzone/diagnostics/main'
import { IPC_TELEMETRY_MAP } from '@slayzone/telemetry/shared'
import { registerAiConfigHandlers } from '@slayzone/ai-config/main'
import { registerIntegrationHandlers, ensureIntegrationSchema, startSyncPoller, pushTaskAfterEdit, pushNewTaskToProviders, pushArchiveToProviders, pushUnarchiveToProviders, startDiscoveryPoller, resetSyncFlags } from '@slayzone/integrations/main'
import { registerFileEditorHandlers, closeAllWatchers } from '@slayzone/file-editor/main'
import { registerTestPanelHandlers } from '@slayzone/test-panel/main'
import { registerUsageAnalyticsHandlers } from '@slayzone/usage-analytics/main'
import { registerScreenshotHandlers } from './screenshot'
import { setProcessManagerWindow, initProcessManager, createProcess, spawnProcess, updateProcess, stopProcess, killProcess, restartProcess, listForTask, listAllProcesses, killTaskProcesses, killAllProcesses } from './process-manager'
import { createStatsPoller } from './pid-stats'
import { registerExportImportHandlers } from './export-import'
import { registerLeaderboardHandlers } from './leaderboard'
import { initAutoUpdater, checkForUpdates, restartForUpdate } from './auto-updater'
import { WEBVIEW_DESKTOP_HANDOFF_SCRIPT } from '../shared/webview-desktop-handoff-script'

const DEFAULT_WINDOW_WIDTH = 1760
const DEFAULT_WINDOW_HEIGHT = 1280

// Splash screen: self-contained HTML with inline logo SVG and typewriter animation
const splashLogoSvg = readFileSync(logoSolid, 'utf-8')
const splashHTML = (version: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      overflow: hidden;
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .container {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #0a0a0a;
      border-radius: 16px;
      position: relative;
    }
    .logo-wrapper {
      animation: fadeInScale 0.4s ease-out forwards;
    }
    .logo {
      width: 192px;
      height: 192px;
      border-radius: 2rem;
      box-shadow: 0 0 80px rgba(59,130,246,0.5), 0 0 160px rgba(59,130,246,0.25);
    }
    .title {
      margin-top: 24px;
      font-size: 28px;
      font-weight: 600;
      color: #fafafa;
      height: 1.5em;
      display: inline-flex;
      align-items: center;
    }
    .typed-text { white-space: pre; }
    .caret {
      display: inline-block;
      width: 2px;
      height: 1.1em;
      margin-left: 4px;
      background: #fafafa;
      animation: blink 0.9s step-end infinite;
    }
    .version {
      position: absolute;
      bottom: 24px;
      font-size: 12px;
      color: #525252;
      opacity: 0;
      animation: fadeIn 0.15s ease-out 0.3s forwards;
    }
    @keyframes fadeInScale {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
    @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    .fade-out { animation: fadeOut 0.3s ease-out forwards; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo-wrapper">
      <img class="logo" src="data:image/svg+xml;base64,${Buffer.from(splashLogoSvg).toString('base64')}" />
    </div>
    <div class="title">
      <span class="typed-text" aria-hidden="true"></span>
      <span class="caret" aria-hidden="true"></span>
    </div>
    <div class="version">v${version}</div>
  </div>
  <script>
    const typedText = document.querySelector('.typed-text')
    const first = 'Breath...'
    const second = 'then slay'
    const TYPE_MS = 60
    const ERASE_MS = 40
    const PAUSE_BEFORE_START = 300
    const PAUSE_AFTER_FIRST = 400
    const PAUSE_AFTER_ERASE = 200

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const typeText = async (text) => {
      for (let i = 0; i < text.length; i += 1) {
        typedText.textContent += text[i]
        await sleep(TYPE_MS)
      }
    }

    const eraseText = async () => {
      while (typedText.textContent.length > 0) {
        typedText.textContent = typedText.textContent.slice(0, -1)
        await sleep(ERASE_MS)
      }
    }

    const runSequence = async () => {
      await sleep(PAUSE_BEFORE_START)
      await typeText(first)
      await sleep(PAUSE_AFTER_FIRST)
      await eraseText()
      await sleep(PAUSE_AFTER_ERASE)
      await typeText(second)
    }

    window.addEventListener('DOMContentLoaded', () => { runSequence() })
  </script>
</body>
</html>
`

let splashWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null
let inlineDevToolsView: BrowserView | null = null
let inlineDevToolsViewAttached = false
let inlineDeviceToolbarDisableTimers: NodeJS.Timeout[] = []
let linearSyncPoller: NodeJS.Timeout | null = null
let discoveryPoller: NodeJS.Timeout | null = null
let mcpCleanup: (() => void) | null = null
type OAuthCallbackPayload = { code?: string; error?: string }
const oauthCallbackQueue: OAuthCallbackPayload[] = []
const oauthCallbackWaiters = new Set<(payload: OAuthCallbackPayload) => void>()
let mainWindowReady = false
let rendererDataReady = false
const APP_PROTOCOL_SCHEME = 'slayzone'
// Avoid stealing the global slayzone:// handler from packaged builds during local dev.
const SHOULD_REGISTER_PROTOCOL_CLIENT = !is.dev || process.env.SLAYZONE_REGISTER_DEV_PROTOCOL === '1'
type ProtocolClientStatusReason = 'registered' | 'dev-skipped' | 'registration-failed'
type ProtocolClientStatus = {
  scheme: string
  attempted: boolean
  registered: boolean
  reason: ProtocolClientStatusReason
}
let protocolClientStatus: ProtocolClientStatus = {
  scheme: APP_PROTOCOL_SCHEME,
  attempted: false,
  registered: false,
  reason: SHOULD_REGISTER_PROTOCOL_CLIENT ? 'registration-failed' : 'dev-skipped'
}
const SUPPORTED_PROTOCOL_SCHEMES = new Set([APP_PROTOCOL_SCHEME])
const OAUTH_DEEP_LINK_REDIRECT_URI = `${APP_PROTOCOL_SCHEME}://auth/callback`
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000

function logBoot(step: string): void {
  if (is.dev && process.env.SLAYZONE_DEBUG_BOOT === '1') {
    console.log(`[boot] ${step}`)
  }
}

function tryShowMainWindow(): void {
  if (!mainWindowReady || !rendererDataReady) return
  if (splashWindow && !splashWindow.isDestroyed()) {
    const bounds = splashWindow.getBounds()
    mainWindow?.setBounds(bounds)
    mainWindow?.show()
    closeSplash()
  } else {
    if (!isPlaywright) mainWindow?.show()
  }
}

interface InlineDevToolsBounds {
  x: number
  y: number
  width: number
  height: number
}

const INLINE_DEVTOOLS_LEFT_TRIM = 0

function normalizeInlineDevToolsBounds(bounds: InlineDevToolsBounds): InlineDevToolsBounds {
  const normalized = {
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
    width: Math.max(1, Math.floor(bounds.width)),
    height: Math.max(1, Math.floor(bounds.height))
  }
  if (normalized.width <= INLINE_DEVTOOLS_LEFT_TRIM + 120) return normalized
  return {
    x: normalized.x + INLINE_DEVTOOLS_LEFT_TRIM,
    y: normalized.y,
    width: normalized.width - INLINE_DEVTOOLS_LEFT_TRIM,
    height: normalized.height
  }
}

function ensureInlineDevToolsView(win: BrowserWindow): BrowserView {
  if (!inlineDevToolsView || inlineDevToolsView.webContents.isDestroyed()) {
    inlineDevToolsView = new BrowserView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  }
  if (!inlineDevToolsViewAttached) {
    win.addBrowserView(inlineDevToolsView)
    inlineDevToolsViewAttached = true
  }
  win.setTopBrowserView(inlineDevToolsView)
  return inlineDevToolsView
}

function removeInlineDevToolsView(win: BrowserWindow | null): void {
  if (!inlineDevToolsView || !inlineDevToolsViewAttached || !win) return
  try {
    win.removeBrowserView(inlineDevToolsView)
  } catch {
    // ignore removal errors
  } finally {
    inlineDevToolsViewAttached = false
    for (const timer of inlineDeviceToolbarDisableTimers) clearTimeout(timer)
    inlineDeviceToolbarDisableTimers = []
  }
}

async function tuneInlineDevToolsFrontend(devtoolsContents: Electron.WebContents): Promise<string> {
  if (devtoolsContents.isDestroyed()) return 'destroyed'
  // Runs once after the DevTools frontend has fully navigated (did-navigate fires when ready).
  // forceUndocked removed — openDevTools({ mode: 'undocked' }) already handles dock state.
  const script = `
    (() => {
      const ui = globalThis.UI
      const common = globalThis.Common
      const settings = common?.Settings?.Settings?.instance?.()

      // Cancel inspect-element mode if active (can activate automatically on open)
      try {
        const registry = ui?.actionRegistry?.instance?.()
        const inspectAction = registry?.action?.('elements.inspect-element')
        if (inspectAction?.toggled?.()) inspectAction.execute?.()
      } catch {}

      // Disable device emulation if it was left on from a previous session
      const deviceModeSetting = settings?.moduleSetting?.('emulation.showDeviceMode')
      if (deviceModeSetting?.get?.() === true) {
        deviceModeSetting.set(false)
        return 'disabled-device-mode-via-setting'
      }
      const registry = ui?.actionRegistry?.instance?.()
      const deviceAction = registry?.action?.('emulation.toggle-device-mode')
      if (deviceAction?.toggled?.() === true) {
        void deviceAction.execute?.()
        return 'disabled-device-mode-via-action'
      }
      return 'ok'
    })();
  `
  try {
    const result = await devtoolsContents.executeJavaScript(script, true)
    console.log('[webview:inline-devtools] tune', { result })
    return String(result)
  } catch (err) {
    console.warn('[webview:inline-devtools] tune-failed', {
      err: err instanceof Error ? err.message : String(err)
    })
    return `error:${err instanceof Error ? err.message : String(err)}`
  }
}

function scheduleDisableDevToolsDeviceToolbar(devtoolsContents: Electron.WebContents): void {
  for (const timer of inlineDeviceToolbarDisableTimers) clearTimeout(timer)
  inlineDeviceToolbarDisableTimers = []
  // Single deferred call after did-navigate has fired — DevTools modules are ready by then.
  // The caller (openDevToolsInline) already awaits tuneInlineDevToolsFrontend once on open;
  // this handles the case where the user navigates the DevTools itself (rare but possible).
  const timer = setTimeout(() => {
    if (devtoolsContents.isDestroyed()) return
    void tuneInlineDevToolsFrontend(devtoolsContents)
  }, 500)
  inlineDeviceToolbarDisableTimers.push(timer)
}

function emitOAuthCallback(payload: { code?: string; error?: string }): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  const waiter = oauthCallbackWaiters.values().next().value as ((p: OAuthCallbackPayload) => void) | undefined
  if (waiter) {
    oauthCallbackWaiters.delete(waiter)
    waiter(payload)
    return
  }

  oauthCallbackQueue.push(payload)
}

function waitForOAuthCallback(timeoutMs: number): Promise<OAuthCallbackPayload> {
  const queued = oauthCallbackQueue.shift()
  if (queued) return Promise.resolve(queued)

  return new Promise<OAuthCallbackPayload>((resolve, reject) => {
    const resolveOnce = (payload: OAuthCallbackPayload) => {
      clearTimeout(timeout)
      oauthCallbackWaiters.delete(resolveOnce)
      resolve(payload)
    }
    const timeout = setTimeout(() => {
      oauthCallbackWaiters.delete(resolveOnce)
      reject(new Error('Timed out waiting for OAuth callback'))
    }, timeoutMs)
    oauthCallbackWaiters.add(resolveOnce)
  })
}

async function requestGithubSignInStart(
  convexUrl: string,
  redirectTo: string
): Promise<{ redirect: string; verifier: string }> {
  let convexSite: URL
  try {
    convexSite = new URL(convexUrl)
  } catch {
    throw new Error('Convex URL is invalid')
  }
  if (convexSite.protocol !== 'https:' && convexSite.protocol !== 'http:') {
    throw new Error('Convex URL must use http or https')
  }

  const response = await fetch(`${convexSite.origin}/api/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Convex-Client': 'electron-main'
    },
    body: JSON.stringify({
      path: 'auth:signIn',
      format: 'convex_encoded_json',
      args: [
        {
          provider: 'github',
          params: { redirectTo }
        }
      ]
    })
  })

  if (!response.ok) {
    throw new Error(`Auth bootstrap failed (${response.status})`)
  }

  const body = (await response.json()) as {
    status?: string
    value?: { redirect?: string; verifier?: string }
    errorMessage?: string
  }
  if (body.status === 'error') {
    throw new Error(body.errorMessage ?? 'Auth bootstrap failed')
  }
  if (body.status !== 'success') {
    throw new Error('Auth bootstrap returned an unexpected response')
  }

  const redirect = body.value?.redirect
  const verifier = body.value?.verifier
  if (!redirect || !verifier) {
    throw new Error('Auth bootstrap response missing redirect or verifier')
  }

  let redirectUrl: URL
  try {
    redirectUrl = new URL(redirect)
  } catch {
    throw new Error('Auth bootstrap returned an invalid redirect URL')
  }
  if (redirectUrl.protocol !== 'https:') {
    throw new Error('GitHub sign-in URL must use https')
  }

  return { redirect: redirectUrl.toString(), verifier }
}

function handleOAuthDeepLink(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }

  const incomingProtocol = parsed.protocol.replace(/:$/, '')
  if (!SUPPORTED_PROTOCOL_SCHEMES.has(incomingProtocol)) return
  const normalizedPath = parsed.pathname.replace(/\/+$/, '')

  // slayzone://task/<id> — open task in app
  if (parsed.hostname === 'task' && normalizedPath.length > 1) {
    const taskId = normalizedPath.slice(1)
    mainWindow?.webContents.send('app:open-task', taskId)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    return
  }

  const isAuthCallback =
    (parsed.hostname === 'auth' && normalizedPath === '/callback') ||
    // Some platforms can normalize custom URLs as slayzone:///auth/callback
    (parsed.hostname === '' && normalizedPath === '/auth/callback')
  if (!isAuthCallback) return

  const hashParams = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash)
  const code = parsed.searchParams.get('code') ?? hashParams.get('code') ?? undefined
  const error =
    parsed.searchParams.get('error_description') ??
    parsed.searchParams.get('error') ??
    hashParams.get('error_description') ??
    hashParams.get('error') ??
    undefined
  emitOAuthCallback({ code, error })
}

function handleOAuthDeepLinkFromArgv(argv: string[]): void {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(`${APP_PROTOCOL_SCHEME}://`)) {
      handleOAuthDeepLink(arg)
      break
    }
  }
}

const shouldEnforceSingleInstanceLock = !isPlaywright && !is.dev
const gotSingleInstanceLock = !shouldEnforceSingleInstanceLock || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.error('[app] Failed to acquire single-instance lock; quitting duplicate instance')
  app.quit()
} else if (shouldEnforceSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    handleOAuthDeepLinkFromArgv(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// On macOS, protocol launches are delivered via open-url.
// Register before app ready so early callback events are not missed.
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleOAuthDeepLink(url)
})

function emitOpenSettings(): void {
  mainWindow?.webContents.send('app:open-settings')
}

function emitOpenProjectSettings(): void {
  mainWindow?.webContents.send('app:open-project-settings')
}

function emitNewTemporaryTask(): void {
  mainWindow?.webContents.send('app:new-temporary-task')
}

const CLI_TARGET = '/usr/local/bin/slay'

function getCliSrc(): string {
  return is.dev
    ? join(app.getAppPath(), '../cli/bin/slay')
    : join(process.resourcesPath, 'bin', 'slay')
}

function installSlayCli(): void {
  const result = installSlayCliResult()
  if (result.ok) {
    dialog.showMessageBox({ message: `'slay' installed to ${CLI_TARGET}` })
  } else if (result.permissionDenied) {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Permission denied',
      detail: `Run this in Terminal to install manually:\n\nsudo ln -sf "${getCliSrc()}" ${CLI_TARGET}`
    })
  } else {
    dialog.showErrorBox('Install failed', result.error ?? 'Unknown error')
  }
}

function installSlayCliResult(): { ok: boolean; permissionDenied?: boolean; error?: string } {
  const src = getCliSrc()
  try {
    if (existsSync(CLI_TARGET)) unlinkSync(CLI_TARGET)
    symlinkSync(src, CLI_TARGET)
    return { ok: true }
  } catch (err: unknown) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EACCES') return { ok: false, permissionDenied: true, error: `sudo ln -sf "${src}" ${CLI_TARGET}` }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function closeSplash(): void {
  if (!splashWindow || splashWindow.isDestroyed()) return
  splashWindow.webContents
    .executeJavaScript(`document.querySelector('.container').classList.add('fade-out')`)
    .then(() => {
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
      }, 300)
    })
    .catch(() => { splashWindow?.close() })
}

function createSplashWindow(): void {
  splashWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 10, y: 12 },
    resizable: false,
    center: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHTML(app.getVersion()))}`)

  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })

  // Escape to dismiss splash early
  splashWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      closeSplash()
    }
  })

  splashWindow.on('closed', () => {
    splashWindow = null
  })
}

function createMainWindow(): void {
  mainWindowReady = false
  rendererDataReady = false
  setTimeout(() => {
    if (rendererDataReady) return
    rendererDataReady = true
    tryShowMainWindow()
  }, 5000)
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    show: false,
    center: true,
    title: 'SlayZone',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 10, y: 12 },
    backgroundColor: '#0a0a0a',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // Required for <webview> in Work Mode browser tabs
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) startIdleChecker(mainWindow)
    mainWindowReady = true
    tryShowMainWindow()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only open http/https/mailto externally — never shell.openExternal a figma:// or other app protocol
    if (/^https?:\/\//i.test(details.url) || details.url.startsWith('mailto:')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    removeInlineDevToolsView(mainWindow)
    inlineDevToolsView = null
    inlineDevToolsViewAttached = false
    mainWindow = null
  })

  // Intercept Cmd+§ at Electron level (react-hotkeys-hook doesn't recognize §)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === '§' && input.meta) {
      event.preventDefault()
      mainWindow?.webContents.send('app:go-home')
      return
    }

    if (input.type === 'keyDown' && input.key === ',' && input.meta && input.shift) {
      event.preventDefault()
      emitOpenProjectSettings()
      return
    }

    if (input.type === 'keyDown' && input.key === ',' && input.meta) {
      event.preventDefault()
      emitOpenSettings()
      return
    }

    if (input.type === 'keyDown' && input.key.toLowerCase() === 's' && input.meta && input.shift) {
      event.preventDefault()
      mainWindow?.webContents.send('app:screenshot-trigger')
    }

    // Cmd+R: send to renderer (browser panel reload or app reload)
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'r' && input.meta && !input.shift && !input.alt) {
      event.preventDefault()
      mainWindow?.webContents.send('app:reload-browser')
    }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createWindow(): void {
  if (!isPlaywright) {
    createSplashWindow()
  }
  createMainWindow()
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// Guard every webContents.send() against disposed render frames.
// `webContents.send()` internally calls `mainFrame.send()` which throws when the
// render frame is disposed (during reload, navigation, or close). The webContents
// itself may still be alive (`isDestroyed()` = false) so a try-catch is the only
// reliable guard. Patching at creation time means no call site needs to remember.
// Only the specific "frame disposed" error is swallowed — other errors (e.g.
// non-serializable args) are re-thrown so real bugs aren't hidden.
app.on('browser-window-created', (_event, win) => {
  const originalSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel: string, ...args: unknown[]) => {
    // Check frame is alive before calling — avoids Electron's internal console warning
    // that fires even when the thrown error is caught in JS.
    try { if (win.isDestroyed() || !win.webContents.mainFrame) return } catch { return }
    try {
      originalSend(channel, ...args)
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('frame was disposed'))) throw err
    }
  }
})

app.whenReady().then(async () => {
  logBoot('whenReady begin')
  if (SHOULD_REGISTER_PROTOCOL_CLIENT) {
    let registered = false
    if (process.defaultApp) {
      const entry = process.argv[1] ? [resolve(process.argv[1])] : []
      registered = app.setAsDefaultProtocolClient(APP_PROTOCOL_SCHEME, process.execPath, entry)
    } else {
      registered = app.setAsDefaultProtocolClient(APP_PROTOCOL_SCHEME)
    }
    protocolClientStatus = {
      scheme: APP_PROTOCOL_SCHEME,
      attempted: true,
      registered,
      reason: registered ? 'registered' : 'registration-failed'
    }
    if (!registered) {
      console.warn(
        `[auth][protocol] Failed to register ${APP_PROTOCOL_SCHEME}:// as default protocol handler. OAuth deep-link callbacks may not open this app.`
      )
    }
    logBoot('protocol client configured')
  } else {
    console.warn(
      `[auth][protocol] Dev protocol registration skipped for ${APP_PROTOCOL_SCHEME}://. Set SLAYZONE_REGISTER_DEV_PROTOCOL=1 to test OAuth deep-link callbacks in dev.`
    )
    logBoot('protocol client registration skipped in dev')
  }
  handleOAuthDeepLinkFromArgv(process.argv)
  logBoot('oauth deep-link handlers initialized')

  // Initialize databases
  logBoot('database init start')
  const db = getDatabase()
  const diagDb = getDiagnosticsDatabase()
  const isLabEnabled = (key: string): boolean => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return is.dev || isPlaywright
    return row.value === '1'
  }
  logBoot('database init complete')

  // Skip onboarding in Playwright — tested explicitly in 02-onboarding.spec.ts
  if (isPlaywright) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')").run()
  }

  registerProcessDiagnostics(app)
  logBoot('process diagnostics registered')

  // Load and apply persisted theme BEFORE creating window to prevent flash
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('theme') as
    | { value: string }
    | undefined
  const savedTheme = row?.value as 'light' | 'dark' | 'system' | undefined
  nativeTheme.themeSource = savedTheme ?? 'dark'

  // Set dock icon on macOS (needed for dev mode)
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon)

    // Set custom application menu to show correct app name in menu items
    const appName = 'SlayZone'
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: appName,
        submenu: [
          { role: 'about', label: `About ${appName}` },
          {
            label: 'Check for Updates...',
            click: () => checkForUpdates()
          },
          {
            label: 'Settings...',
            accelerator: 'Cmd+,',
            click: () => emitOpenSettings()
          },
          {
            label: 'Project Settings...',
            accelerator: 'Cmd+Shift+,',
            click: () => emitOpenProjectSettings()
          },
          { type: 'separator' },
          {
            label: "Install 'slay' CLI...",
            click: () => installSlayCli()
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${appName}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${appName}` }
        ]
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'New Temporary Task',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => emitNewTemporaryTask()
          }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Reload',
            accelerator: 'CmdOrCtrl+R',
            registerAccelerator: false,
            click: () => mainWindow?.webContents.send('app:reload-browser')
          },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          {
            label: 'Close Tab',
            accelerator: 'CmdOrCtrl+W',
            click: () => mainWindow?.webContents.send('app:close-current-focus')
          },
          {
            label: 'Close Task',
            accelerator: 'CmdOrCtrl+Shift+W',
            click: () => mainWindow?.webContents.send('app:close-active-task')
          },
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  // Register diagnostics first so IPC handlers below are instrumented.
  registerDiagnosticsHandlers(ipcMain, db, diagDb)
  setIpcSuccessHook((channel, args, result) => {
    const entry = IPC_TELEMETRY_MAP[channel]
    if (!entry) return
    const props = entry.props(args, result)
    if (props === undefined) return
    mainWindow?.webContents.send('telemetry:ipc-event', entry.event, props)
  })
  logBoot('diagnostics IPC registered')

  configureTaskRuntimeAdapters({
    killPtysByTaskId,
    killTaskProcesses,
    recordDiagnosticEvent,
  })
  logBoot('task runtime adapters configured')

  // Register domain handlers (inject ipcMain and db)
  registerProjectHandlers(ipcMain, db)
  registerTaskHandlers(ipcMain, db)
  registerTagHandlers(ipcMain, db)
  registerSettingsHandlers(ipcMain, db)

  // Feedback handlers (lightweight, no domain package)
  ipcMain.handle('db:feedback:listThreads', () => {
    return db.prepare('SELECT id, title, discord_thread_id, created_at FROM feedback_threads ORDER BY created_at DESC').all()
  })
  ipcMain.handle('db:feedback:createThread', (_, input: { id: string; title: string; discord_thread_id: string | null }) => {
    db.prepare('INSERT INTO feedback_threads (id, title, discord_thread_id) VALUES (?, ?, ?)').run(input.id, input.title, input.discord_thread_id)
  })
  ipcMain.handle('db:feedback:getMessages', (_, threadId: string) => {
    return db.prepare('SELECT id, thread_id, content, created_at FROM feedback_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId)
  })
  ipcMain.handle('db:feedback:addMessage', (_, input: { id: string; thread_id: string; content: string }) => {
    db.prepare('INSERT INTO feedback_messages (id, thread_id, content) VALUES (?, ?, ?)').run(input.id, input.thread_id, input.content)
  })
  ipcMain.handle('db:feedback:updateThreadDiscordId', (_, threadId: string, discordThreadId: string) => {
    db.prepare('UPDATE feedback_threads SET discord_thread_id = ? WHERE id = ?').run(discordThreadId, threadId)
  })
  ipcMain.handle('db:feedback:deleteThread', (_, threadId: string) => {
    db.prepare('DELETE FROM feedback_threads WHERE id = ?').run(threadId)
  })

  registerThemeHandlers(ipcMain, db)
  registerUsageHandlers(ipcMain, db)
  registerPtyHandlers(ipcMain, db)

  // Expose test helpers for e2e
  if (isPlaywright) {
    ;(globalThis as Record<string, unknown>).__db = db
    ;(globalThis as Record<string, unknown>).__spawnProcess = spawnProcess
    ;(globalThis as Record<string, unknown>).__restorePtyHandlers = () => {
      for (const ch of [
        'terminalModes:list',
        'terminalModes:test',
        'terminalModes:get',
        'terminalModes:create',
        'terminalModes:update',
        'terminalModes:delete',
        'terminalModes:restoreDefaults',
        'terminalModes:resetToDefaultState',
        'pty:create',
        'pty:testExecutionContext',
        'pty:ccsListProfiles',
        'pty:write',
        'pty:resize',
        'pty:kill',
        'pty:exists',
        'pty:getBuffer',
        'pty:clearBuffer',
        'pty:getBufferSince',
        'pty:list',
        'pty:getState',
        'pty:dismissAllNotifications',
        'pty:set-theme',
        'pty:validate',
      ]) {
        ipcMain.removeHandler(ch)
      }
      registerPtyHandlers(ipcMain, db)
    }
  }

  registerTerminalTabsHandlers(ipcMain, db)
  registerFilesHandlers(ipcMain)
  registerWorktreeHandlers(ipcMain, db)
  registerAiConfigHandlers(ipcMain, db)
  const integrationHandles = registerIntegrationHandlers(ipcMain, db, { enableTestChannels: isPlaywright })
  registerFileEditorHandlers(ipcMain)
  registerScreenshotHandlers()
  registerExportImportHandlers(ipcMain, db, isPlaywright)
  registerLeaderboardHandlers(ipcMain, db)
  registerTestPanelHandlers(ipcMain, db)
  registerUsageAnalyticsHandlers(ipcMain, db)
  registerBackupHandlers(ipcMain, db)
  startAutoBackup(db)
  logBoot('domain IPC handlers registered')

  // Start MCP server — preferred port from settings, falls back to dynamic port on conflict
  import('./mcp-server').then((mod) => {
    mod.startMcpServer(db)
    mcpCleanup = () => mod.stopMcpServer()
  }).catch((err) => {
    console.error('[MCP] Failed to start server:', err)
  })

  const notifyTasksChanged = () => { mainWindow?.webContents.send('tasks:changed') }
  linearSyncPoller = startSyncPoller(db, notifyTasksChanged)
  discoveryPoller = startDiscoveryPoller(db, notifyTasksChanged)
  logBoot('integration pollers started (sync 10s, discovery 60s)')

  // Push to providers immediately after local task edits (skip in E2E — tests exercise push explicitly)
  if (!isPlaywright) {
    ipcMain.on('db:tasks:update:done', (_event, taskId: string) => {
      void pushTaskAfterEdit(db, taskId, {
        pushGithubTask: integrationHandles.pushGithubTask
      })
    })
  }

  if (!isPlaywright) {
    // Push new tasks to providers (two_way sync)
    ipcMain.on('db:tasks:create:done', (_event, taskId: string, projectId: string) => {
      void pushNewTaskToProviders(db, taskId, projectId).then(() => {
        // Only notify if a link was actually created
        const hasLink = db.prepare('SELECT 1 FROM external_links WHERE task_id = ? LIMIT 1').get(taskId)
        if (hasLink) notifyTasksChanged()
      })
    })

    // Archive/unarchive sync to providers
    ipcMain.on('db:tasks:archive:done', (_event, taskId: string) => {
      void pushArchiveToProviders(db, taskId)
    })
    ipcMain.on('db:tasks:unarchive:done', (_event, taskId: string) => {
      void pushUnarchiveToProviders(db, taskId)
    })
  }

  initAutoUpdater()
  logBoot('auto-updater initialized')

  // Configure webview session for WebAuthn/passkey support
  const browserSession = session.fromPartition('persist:browser-tabs')

  // Strip Electron/app name from user-agent so sites (Figma, etc.) don't detect
  // Electron and redirect to their desktop app instead of serving the web version.
  const rawUa = browserSession.getUserAgent()
  _chromeUa = rawUa
    .replace(/\s*Electron\/\S+/i, '')
    .replace(/\s*slayzone\/\S+/i, '')
  _chromiumVersion = rawUa.match(/Chrome\/(\d+)/)?.[1] || '142'
  browserSession.setUserAgent(_chromeUa)

  // Serve local files via slz-file:// (Chromium blocks file:// in webviews and cross-origin renderers)
  const userHome = homedir()
  const slzFileHandler = async (request: Request) => {
    // slz-file:///path/to/file → /path/to/file
    const filePath = normalize(decodeURIComponent(request.url.replace(/^slz-file:\/\//, '')))

    // Block path traversal outside user home directory
    if (!filePath.startsWith(userHome + sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
      '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      '.pdf': 'application/pdf', '.xml': 'application/xml', '.txt': 'text/plain',
    }
    try {
      const data = await fsp.readFile(filePath)
      return new Response(data, {
        headers: { 'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
  const webPanelSession = session.fromPartition('persist:web-panels')
  webPanelSession.setUserAgent(_chromeUa)

  // Block external protocol navigation from inside webview pages (e.g. window.location = 'figma://...')
  // session.protocol.handle only intercepts loadURL from the main process — page-initiated
  // navigation bypasses it. A session preload patches window.open/location before page JS runs.
  const webviewPreload = join(__dirname, '../preload/webview-preload.js')
  browserSession.registerPreloadScript({ type: 'frame', filePath: webviewPreload, id: 'webview-preload' })
  webPanelSession.registerPreloadScript({ type: 'frame', filePath: webviewPreload, id: 'webview-preload-wp' })

  // Override Sec-CH-UA header to include "Google Chrome" brand.
  // This is synchronous (fires before each request) so it's reliable even if CDP hasn't finished.
  const secChUa = `"Google Chrome";v="${_chromiumVersion}", "Chromium";v="${_chromiumVersion}", "Not_A Brand";v="8"`
  const overrideSecChUa = (details: Electron.OnBeforeSendHeadersListenerDetails, cb: (resp: Electron.BeforeSendResponse) => void) => {
    details.requestHeaders['Sec-CH-UA'] = secChUa
    details.requestHeaders['Sec-CH-UA-Full-Version-List'] = `"Google Chrome";v="${_chromiumVersion}.0.0.0", "Chromium";v="${_chromiumVersion}.0.0.0", "Not_A Brand";v="8.0.0.0"`
    cb({ requestHeaders: details.requestHeaders })
  }
  browserSession.webRequest.onBeforeSendHeaders(overrideSecChUa)
  webPanelSession.webRequest.onBeforeSendHeaders(overrideSecChUa)

  const shouldCancelLoopbackHandoffRequest = (
    details: Electron.OnBeforeRequestListenerDetails
  ): boolean => {
    const webviewId = details.webContentsId
    if (typeof webviewId !== 'number') return false

    const desktopHandoffPolicy = webviewDesktopHandoffPolicy.get(webviewId)
    if (!desktopHandoffPolicy) return false
    if (!isLoopbackUrl(details.url)) return false

    const hostScope = normalizeDesktopHostScope(desktopHandoffPolicy.hostScope)
    if (isLoopbackHost(hostScope)) return false

    if (hostScope) {
      const sourceUrl =
        (details.frame && details.frame.url) ||
        (details.referrer && details.referrer !== 'about:blank' ? details.referrer : '') ||
        details.webContents?.getURL() ||
        ''
      if (sourceUrl && !isUrlWithinHostScope(sourceUrl, hostScope)) return false
    }

    return true
  }

  const blockLoopbackHandoff = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void
  ) => {
    if (shouldCancelLoopbackHandoffRequest(details)) {
      callback({ cancel: true })
      return
    }
    callback({ cancel: false })
  }
  browserSession.webRequest.onBeforeRequest(blockLoopbackHandoff)
  webPanelSession.webRequest.onBeforeRequest(blockLoopbackHandoff)

  browserSession.protocol.handle('slz-file', slzFileHandler)
  webPanelSession.protocol.handle('slz-file', slzFileHandler)
  session.defaultSession.protocol.handle('slz-file', slzFileHandler)

  // Block external app protocol launches from webviews by registering no-op handlers.
  // External protocol URLs (figma://, slack://, etc.) bypass will-navigate entirely —
  // Chromium passes them straight to the OS. Registering the scheme in the session
  // routes them through our handler instead, returning 204 so the webview stays put.
  const blockProtocol = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  for (const scheme of BLOCKED_EXTERNAL_PROTOCOLS) {
    browserSession.protocol.handle(scheme, blockProtocol)
    webPanelSession.protocol.handle(scheme, blockProtocol)
    // Default session covers popup windows created by allowpopups webviews
    session.defaultSession.protocol.handle(scheme, blockProtocol)
  }

  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = ['hid', 'usb', 'clipboard-read', 'clipboard-write']
    callback(allowedPermissions.includes(permission) || permission === 'unknown')
  })

  browserSession.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'hid' || details.deviceType === 'usb') {
      return true
    }
    return false
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.slayzone.app')

  // Open DevTools by F12 in development
  if (is.dev) {
    app.on('browser-window-created', (_, window) => {
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.code === 'F12') {
          const wc = window.webContents
          if (wc.isDevToolsOpened()) wc.closeDevTools()
          else wc.openDevTools({ mode: 'undocked' })
          event.preventDefault()
        }
      })
    })
  }

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Shell: open external URLs (restrict to safe schemes)
  ipcMain.handle('shell:open-external', (_event, url: string, options?: {
    blockDesktopHandoff?: boolean
    desktopHandoff?: DesktopHandoffPolicy
  }) => {
    if (!/^https?:\/\//i.test(url) && !url.startsWith('mailto:')) {
      throw new Error('Only http, https, and mailto URLs are allowed')
    }
    const desktopHandoffPolicy = options?.desktopHandoff ?? (() => {
      if (!options?.blockDesktopHandoff) return null
      const protocol = normalizeDesktopProtocol(inferProtocolFromUrl(url))
      if (!protocol) return null
      const hostScope = normalizeDesktopHostScope(inferHostScopeFromUrl(url))
      return hostScope ? { protocol, hostScope } : { protocol }
    })()
    const shouldBlockLoopbackDesktopHandoff =
      desktopHandoffPolicy !== null &&
      isLoopbackUrl(url) &&
      !isLoopbackHost(normalizeDesktopHostScope(desktopHandoffPolicy.hostScope))
    if (
      desktopHandoffPolicy &&
      (isEncodedDesktopHandoffUrl(url, desktopHandoffPolicy) || shouldBlockLoopbackDesktopHandoff)
    ) {
      throw new Error('Blocked external app handoff URL')
    }
    shell.openExternal(url)
  })

  ipcMain.handle('auth:github-system-sign-in', async (_event, input: {
    convexUrl: string
    redirectTo: string
  }) => {
    try {
      if (!input?.convexUrl) {
        return { ok: false, error: 'Convex URL is required' }
      }
      if (input.redirectTo !== OAUTH_DEEP_LINK_REDIRECT_URI) {
        return { ok: false, error: `Unsupported redirect URI: ${input.redirectTo}` }
      }
      if (oauthCallbackWaiters.size > 0) {
        return { ok: false, error: 'An OAuth sign-in flow is already in progress' }
      }

      // Ignore stale callbacks from prior sign-in attempts.
      oauthCallbackQueue.length = 0

      const start = await requestGithubSignInStart(input.convexUrl, input.redirectTo)
      await shell.openExternal(start.redirect)

      const callback = await waitForOAuthCallback(OAUTH_CALLBACK_TIMEOUT_MS)
      if (callback.error) {
        return { ok: false, verifier: start.verifier, error: callback.error }
      }
      if (!callback.code) {
        return { ok: false, verifier: start.verifier, error: 'OAuth callback missing code' }
      }
      return { ok: true, verifier: start.verifier, code: callback.code }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'GitHub sign-in failed'
      }
    }
  })

  ipcMain.on('app:data-ready', () => {
    if (rendererDataReady) return
    rendererDataReady = true
    tryShowMainWindow()
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('app:is-context-manager-enabled', () => isLabEnabled('labs_context_manager'))
  ipcMain.on('app:is-context-manager-enabled-sync', (event) => { event.returnValue = isLabEnabled('labs_context_manager') })
  ipcMain.handle('app:is-tests-panel-enabled', () => isLabEnabled('labs_tests_panel'))
  ipcMain.on('app:is-tests-panel-enabled-sync', (event) => { event.returnValue = isLabEnabled('labs_tests_panel') })
  ipcMain.handle('app:is-jira-integration-enabled', () => isLabEnabled('labs_jira_integration'))
  ipcMain.on('app:is-jira-integration-enabled-sync', (event) => { event.returnValue = isLabEnabled('labs_jira_integration') })
  ipcMain.handle('app:get-protocol-client-status', () => protocolClientStatus)
  ipcMain.handle('app:restart-for-update', () => restartForUpdate())
  ipcMain.handle('app:check-for-updates', () => checkForUpdates())
  ipcMain.handle('app:cli-status', () => ({ installed: existsSync(CLI_TARGET) }))
  ipcMain.handle('app:install-cli', () => installSlayCliResult())

  // Window close
  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
  })

  // Dialog
  ipcMain.handle(
    'dialog:showOpenDialog',
    async (
      _,
      options: {
        title?: string
        defaultPath?: string
        properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
      }
    ) => {
      return dialog.showOpenDialog(options)
    }
  )

  // Browser panel registry (CLI browser control)
  ipcMain.handle('webview:register-browser-panel', (_, taskId: string, webContentsId: number) => {
    registerBrowserPanel(taskId, webContentsId)
  })
  ipcMain.handle('webview:unregister-browser-panel', (_, taskId: string) => {
    unregisterBrowserPanel(taskId)
  })

  // Webview shortcut interception
  const registeredWebviews = new Set<number>()

  ipcMain.handle('webview:register-shortcuts', (event, webviewId: number) => {
    if (registeredWebviews.has(webviewId)) return

    const wc = webContents.fromId(webviewId)
    if (!wc) return

    registeredWebviews.add(webviewId)

    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      if (!(input.control || input.meta)) return

      // Cmd/Ctrl+1-9 for tab switching, T/A/D/L reserved for panel actions
      if (/^[1-9tadl]$/i.test(input.key)) {
        e.preventDefault()
        event.sender.send('webview:shortcut', {
          key: input.key.toLowerCase(),
          shift: Boolean(input.shift),
          webviewId
        })
      }
    })

    wc.on('destroyed', () => registeredWebviews.delete(webviewId))
  })

  ipcMain.handle('webview:set-desktop-handoff-policy', (_, webviewId: number, policy: DesktopHandoffPolicy | null) => {
    const wc = webContents.fromId(webviewId)
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return false

    if (policy === null) {
      webviewDesktopHandoffPolicy.delete(webviewId)
      return true
    }
    const protocol = normalizeDesktopProtocol(policy.protocol)
    if (!protocol) {
      webviewDesktopHandoffPolicy.delete(webviewId)
      return false
    }
    const hostScope = normalizeDesktopHostScope(policy.hostScope) ?? undefined
    webviewDesktopHandoffPolicy.set(webviewId, hostScope ? { protocol, hostScope } : { protocol })

    if (!webviewDesktopHandoffPolicyCleanupRegistered.has(webviewId)) {
      webviewDesktopHandoffPolicyCleanupRegistered.add(webviewId)
      wc.once('destroyed', () => {
        webviewDesktopHandoffPolicy.delete(webviewId)
        webviewDesktopHandoffPolicyCleanupRegistered.delete(webviewId)
      })
    }
    return true
  })

  ipcMain.handle('webview:open-devtools-bottom', async (_, webviewId: number, options?: { probe?: boolean }) => {
    const wc = webContents.fromId(webviewId)
    if (!wc || wc.isDestroyed()) {
      console.warn('[webview:open-devtools-bottom] missing/destroyed webContents', { webviewId })
      return false
    }

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitForEvent = (event: 'devtools-opened' | 'devtools-closed', timeoutMs = 500) =>
      new Promise<boolean>((resolve) => {
        const emitter = wc as unknown as NodeJS.EventEmitter
        let settled = false
        const handler = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(true)
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          emitter.removeListener(event, handler)
          resolve(false)
        }, timeoutMs)
        emitter.once(event, handler)
      })

    const attempts: Array<{
      mode: 'bottom' | 'right' | 'undocked' | 'detach'
      activate: boolean
      before: boolean
      after: boolean
      openedEvent: boolean
      elapsedMs: number
      error?: string
    }> = []

    const variants: Array<{ mode: 'bottom' | 'right' | 'undocked' | 'detach'; activate: boolean }> = [
      { mode: 'bottom', activate: false },
      { mode: 'bottom', activate: true },
      { mode: 'right', activate: false },
      { mode: 'right', activate: true },
      { mode: 'undocked', activate: false },
      { mode: 'undocked', activate: true },
      { mode: 'detach', activate: false },
      { mode: 'detach', activate: true },
    ]

    for (const variant of variants) {
      try {
        if (wc.isDevToolsOpened()) {
          wc.closeDevTools()
          await waitForEvent('devtools-closed', 300)
        }
      } catch {
        // continue probing
      }
      await wait(50)

      const before = wc.isDevToolsOpened()
      let error: string | undefined
      const startedAt = Date.now()
      let openedEvent = false
      try {
        const openedPromise = waitForEvent('devtools-opened', 700)
        wc.openDevTools({ mode: variant.mode, activate: variant.activate })
        openedEvent = await openedPromise
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      await wait(80)
      const after = wc.isDevToolsOpened()
      const elapsedMs = Date.now() - startedAt

      attempts.push({
        mode: variant.mode,
        activate: variant.activate,
        before,
        after,
        openedEvent,
        elapsedMs,
        ...(error ? { error } : {})
      })

      if (!options?.probe && after) {
        console.log('[webview:open-devtools-bottom] selected variant', { webviewId, mode: variant.mode, activate: variant.activate, openedEvent, elapsedMs })
        return true
      }
    }

    if (options?.probe) {
      return {
        ok: true,
        webviewId,
        type: wc.getType(),
        attempts
      }
    }

    console.warn('[webview:open-devtools-bottom] failed to open', { webviewId, attempts })
    return wc.isDevToolsOpened()
  })

  ipcMain.handle('webview:close-devtools', (_, webviewId: number) => {
    const wc = webContents.fromId(webviewId)
    if (!wc || wc.isDestroyed()) {
      console.warn('[webview:close-devtools] missing/destroyed webContents', { webviewId })
      return false
    }
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    console.log('[webview:close-devtools]', { webviewId, opened: wc.isDevToolsOpened() })
    return true
  })

  ipcMain.handle('webview:open-devtools-detached', async (_, webviewId: number) => {
    const wc = webContents.fromId(webviewId)
    if (!wc || wc.isDestroyed()) {
      console.warn('[webview:open-devtools-detached] missing/destroyed webContents', { webviewId })
      return false
    }

    const emitter = wc as unknown as NodeJS.EventEmitter
    const waitForOpened = (timeoutMs = 1000) =>
      new Promise<boolean>((resolve) => {
        let settled = false
        const handler = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(true)
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          emitter.removeListener('devtools-opened', handler)
          resolve(false)
        }, timeoutMs)
        emitter.once('devtools-opened', handler)
      })

    try {
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      const openedPromise = waitForOpened()
      wc.openDevTools({ mode: 'detach', activate: true })
      const opened = await openedPromise
      if (opened) return true
      return wc.isDevToolsOpened()
    } catch (err) {
      console.warn('[webview:open-devtools-detached] failed', { webviewId, err: err instanceof Error ? err.message : String(err) })
      return false
    }
  })

  ipcMain.handle('webview:open-devtools-inline', async (_, targetWebviewId: number, bounds: InlineDevToolsBounds) => {
    const target = webContents.fromId(targetWebviewId)
    if (!target || target.isDestroyed()) {
      console.warn('[webview:open-devtools-inline] missing target', { targetWebviewId })
      return { ok: false as const, reason: 'missing-target' as const }
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.warn('[webview:open-devtools-inline] missing main window', { targetWebviewId })
      return { ok: false as const, reason: 'missing-main-window' as const }
    }
    const view = ensureInlineDevToolsView(mainWindow)
    view.setBounds(normalizeInlineDevToolsBounds(bounds))
    const host = view.webContents

    // devtools-opened event and isDevToolsOpened() don't fire/return true in Electron 39+
    // when using setDevToolsWebContents — the native window never fully opens.
    // Detect success by watching the host WebContents URL navigate to devtools://.
    const waitForHostDevTools = (timeoutMs = 6000) =>
      new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (result: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          host.off('did-navigate', onNavigate)
          resolve(result)
        }
        const timer = setTimeout(() => settle(false), timeoutMs)
        const isDevToolsUrl = (url: string) => url.startsWith('devtools://') || url.includes('chrome-devtools://')
        const onNavigate = (_: unknown, url: string) => { if (isDevToolsUrl(url)) settle(true) }
        host.on('did-navigate', onNavigate)
        // Check if already loaded
        const current = host.getURL()
        if (isDevToolsUrl(current)) settle(true)
      })

    try {
      if (target.isDevToolsOpened()) target.closeDevTools()
      target.setDevToolsWebContents(host)

      if (!target.isDestroyed()) {
        if (target.isDevToolsOpened()) target.closeDevTools()
        const hostDevToolsPromise = waitForHostDevTools()
        // Intercept the native DevTools popup window that undocked mode creates.
        // Register BEFORE openDevTools() so we catch the window at creation time,
        // before Electron calls Show() on it.
        let popupCaught = false
        const suppressPopup = (_: unknown, win: Electron.BrowserWindow) => {
          popupCaught = true
          if (win.isDestroyed()) return
          win.setOpacity(0)
          win.setBounds({ x: -32000, y: -32000, width: 1, height: 1 })
          const hide = () => { if (!win.isDestroyed()) { win.setOpacity(0); win.setBounds({ x: -32000, y: -32000, width: 1, height: 1 }); win.hide() } }
          win.on('ready-to-show', hide)
          win.on('show', hide)
        }
        app.once('browser-window-created', suppressPopup)
        target.openDevTools({ mode: 'undocked', activate: false })
        // Clean up listener if openDevTools didn't create a window (e.g. already opened).
        // Only wait if the popup hasn't been caught yet — avoids unnecessary 500ms delay
        // on the common (pre-warm already attached) path.
        const cleanupSuppressListener = () => app.off('browser-window-created', suppressPopup)
        const hostLoaded = await hostDevToolsPromise
        if (!popupCaught) await new Promise(resolve => setTimeout(resolve, 500))
        cleanupSuppressListener()
        if (hostLoaded) {
          view.setBounds(normalizeInlineDevToolsBounds(bounds))
          let deviceToolbarResult: string | undefined
          // Tune after did-navigate so DevTools modules (UI, Common) are fully loaded.
          // If already navigated (pre-warm path), call immediately; otherwise wait for nav.
          const isDevToolsUrl = (url: string) => url.startsWith('devtools://') || url.includes('chrome-devtools://')
          const runTune = async () => {
            deviceToolbarResult = await tuneInlineDevToolsFrontend(host)
            scheduleDisableDevToolsDeviceToolbar(host)
          }
          if (isDevToolsUrl(host.getURL())) {
            await runTune()
          } else {
            host.once('did-navigate', (_, url) => { if (isDevToolsUrl(url)) void runTune() })
          }
          console.log('[webview:open-devtools-inline] opened', {
            targetWebviewId,
            targetType: target.getType(),
            hostType: host.getType(),
            deviceToolbarResult,
          })
          return {
            ok: true as const,
            reason: 'opened' as const,
            targetType: target.getType(),
            hostType: host.getType(),
            mode: 'undocked' as const,
            deviceToolbar: deviceToolbarResult,
          }
        }
      }

      console.warn('[webview:open-devtools-inline] failed', {
        targetWebviewId,
        targetType: target.getType(),
        hostType: host.getType(),
      })
      return {
        ok: false as const,
        reason: 'no-variant-opened' as const,
        targetType: target.getType(),
        hostType: host.getType(),
      }
    } catch (err) {
      console.warn('[webview:open-devtools-inline] failed', {
        targetWebviewId,
        targetType: target.getType(),
        hostType: host.getType(),
        err: err instanceof Error ? err.message : String(err)
      })
      return {
        ok: false as const,
        reason: 'exception' as const,
        targetType: target.getType(),
        hostType: host.getType(),
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle('webview:update-devtools-inline-bounds', (_, bounds: InlineDevToolsBounds) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    if (!inlineDevToolsView || inlineDevToolsView.webContents.isDestroyed()) return false
    if (!inlineDevToolsViewAttached) return false
    mainWindow.setTopBrowserView(inlineDevToolsView)
    inlineDevToolsView.setBounds(normalizeInlineDevToolsBounds(bounds))
    return true
  })

  ipcMain.handle('webview:close-devtools-inline', (_, targetWebviewId?: number) => {
    if (typeof targetWebviewId === 'number') {
      const target = webContents.fromId(targetWebviewId)
      if (target && !target.isDestroyed() && target.isDevToolsOpened()) {
        target.closeDevTools()
      }
    }
    removeInlineDevToolsView(mainWindow)
    return true
  })

  ipcMain.handle('webview:is-devtools-opened', (_, webviewId: number) => {
    const wc = webContents.fromId(webviewId)
    if (!wc || wc.isDestroyed()) return false
    return wc.isDevToolsOpened()
  })

  // Webview device emulation
  ipcMain.handle(
    'webview:enable-device-emulation',
    (_, webviewId: number, params: {
      screenSize: { width: number; height: number }
      viewSize: { width: number; height: number }
      deviceScaleFactor: number
      screenPosition: 'mobile' | 'desktop'
      userAgent?: string
    }) => {
      const wc = webContents.fromId(webviewId)
      if (!wc) return false
      wc.enableDeviceEmulation({
        screenPosition: params.screenPosition,
        screenSize: params.screenSize,
        viewSize: params.viewSize,
        deviceScaleFactor: params.deviceScaleFactor,
        viewPosition: { x: 0, y: 0 },
        scale: 1,
      })
      if (params.userAgent) {
        wc.setUserAgent(params.userAgent)
      }
      return true
    }
  )

  ipcMain.handle('webview:disable-device-emulation', (_, webviewId: number) => {
    const wc = webContents.fromId(webviewId)
    if (!wc) return false
    wc.disableDeviceEmulation()
    wc.setUserAgent(_chromeUa)
    return true
  })


  initProcessManager(db)
  logBoot('process manager initialized')

  // Reset all main-process state + DB for test isolation (Playwright only)
  if (isPlaywright) {
    ipcMain.handle('app:reset-for-test', async () => {
      // 1. Kill running processes
      killAllPtys()
      dismissAllNotifications()
      stopIdleChecker()
      killAllProcesses()

      // 2. Stop timers
      stopAutoBackup()
      if (linearSyncPoller) { clearInterval(linearSyncPoller); linearSyncPoller = null }
      if (discoveryPoller) { clearInterval(discoveryPoller); discoveryPoller = null }

      // 3. Stop MCP server (restarted after table drop so port persists)
      mcpCleanup?.()
      mcpCleanup = null
      ;(globalThis as Record<string, unknown>).__mcpPort = undefined

      // 4. Close file watchers
      closeAllWatchers()

      // 5. Clear registries + flags
      clearBrowserRegistry()
      resetSyncFlags()

      // 6. Clear oauth state
      oauthCallbackQueue.length = 0
      oauthCallbackWaiters.clear()

      // 7. Drop all tables + re-migrate
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all() as { name: string }[]
      db.exec('PRAGMA foreign_keys = OFF')
      for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`)
      db.exec('PRAGMA foreign_keys = ON')
      db.pragma('user_version = 0')
      runMigrations(db)
      ensureIntegrationSchema(db)
      normalizeProjectStatusData(db)
      syncTerminalModes(db)

      // 7b. Seed post-onboarding baseline so tests skip the onboarding wizard
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')").run()

      // 8. Restart MCP (after table drop so port is persisted to fresh settings table)
      const mcpMod = await import('./mcp-server')
      mcpMod.startMcpServer(db)
      mcpCleanup = () => mcpMod.stopMcpServer()
      // Wait for server to be listening (listen callback sets __mcpPort)
      await new Promise<void>((resolve) => {
        const check = () => (globalThis as Record<string, unknown>).__mcpPort ? resolve() : setTimeout(check, 10)
        check()
      })

      // 9. Re-init process manager
      initProcessManager(db)
      return { ok: true }
    })
  }

  createWindow()
  logBoot('windows created')
  if (mainWindow) setProcessManagerWindow(mainWindow)

  // PTY stats poller — lazy start/stop via session lifecycle
  const ptyStatsPoller = createStatsPoller(
    () => getPtyPids(),
    (stats) => { mainWindow?.webContents.send('pty:stats', stats) }
  )
  onSessionChange(() => ptyStatsPoller.ensureStarted())

  // Register process IPC handlers
  ipcMain.handle('processes:create', (_event, projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean) => {
    return createProcess(projectId, taskId, label, command, cwd, autoRestart)
  })
  ipcMain.handle('processes:spawn', (_event, projectId: string | null, taskId: string | null, label: string, command: string, cwd: string, autoRestart: boolean) => {
    return spawnProcess(projectId, taskId, label, command, cwd, autoRestart)
  })
  ipcMain.handle('processes:update', (_event, processId: string, updates: Parameters<typeof updateProcess>[1]) => {
    return updateProcess(processId, updates)
  })
  ipcMain.handle('processes:stop', (_event, processId: string) => {
    return stopProcess(processId)
  })
  ipcMain.handle('processes:kill', (_event, processId: string) => {
    return killProcess(processId)
  })
  ipcMain.handle('processes:restart', (_event, processId: string) => {
    return restartProcess(processId)
  })
  ipcMain.handle('processes:listForTask', (_event, taskId: string | null, projectId: string | null) => {
    return listForTask(taskId, projectId)
  })
  ipcMain.handle('processes:listAll', () => {
    return listAllProcesses()
  })
  ipcMain.handle('processes:killTask', (_event, taskId: string) => {
    killTaskProcesses(taskId)
  })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
}).catch((error) => {
  console.error('[boot] whenReady failed:', error)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
// Block external app protocol launches from any WebContents.
// 'webview' type: the webview guest pages.
// 'window' type: popup windows created by webviews with allowpopups="true".
// Both need guards because allowpopups popups are type 'window', not 'webview'.
let _chromeUa = ''
let _chromiumVersion = ''
const _uaPlatform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
const _uaPlatformVersion = process.platform === 'darwin' ? '14.0.0' : process.platform === 'win32' ? '10.0.0' : '6.0.0'
const isBlockedScheme = (url: string) => isBlockedExternalProtocolUrl(url)
const webviewDesktopHandoffPolicy = new Map<number, DesktopHandoffPolicy>()
const webviewDesktopHandoffPolicyCleanupRegistered = new Set<number>()

// Protocol-blocking script injected into the webview main world.
// NOTE: session.registerPreloadScript runs in an isolated world and can't override page globals,
// so we also execute this same script in the page main world via webContents.executeJavaScript.
const WEBVIEW_INIT_SCRIPT = WEBVIEW_DESKTOP_HANDOFF_SCRIPT

app.on('web-contents-created', (_, wc) => {
  const isLoopbackHandoffUrlForWebview = (url: string): boolean => {
    if (wc.getType() !== 'webview') return false
    const desktopHandoffPolicy = webviewDesktopHandoffPolicy.get(wc.id)
    if (!desktopHandoffPolicy) return false
    if (!isLoopbackUrl(url)) return false
    const hostScope = normalizeDesktopHostScope(desktopHandoffPolicy.hostScope)
    if (isLoopbackHost(hostScope)) return false
    return true
  }

  const shouldBlockDesktopHandoffUrl = (url: string): boolean => {
    if (isLoopbackHandoffUrlForWebview(url)) return true
    if (wc.getType() !== 'webview') return false
    const desktopHandoffPolicy = webviewDesktopHandoffPolicy.get(wc.id)
    if (!desktopHandoffPolicy) return false
    return isEncodedDesktopHandoffUrl(url, desktopHandoffPolicy)
  }

  // Allow http/https popups as real BrowserWindows (needed for OAuth flows like Google Sign-In)
  // but deny external protocol popups (figma://, slack://, etc.).
  // The renderer's 'new-window' event still fires — BrowserPanel/WebPanelView skip
  // disposition:'new-window' to avoid double-opening.
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler((details) => {
      // Webviews with desktop handoff policies (Figma, etc.) must deny popups so the
      // renderer can apply UA spoofing, script injection, and same-host navigation.
      if (webviewDesktopHandoffPolicy.has(wc.id)) return { action: 'deny' }
      // Only allow window.open() with features (disposition 'new-window') for http/https.
      // These are OAuth/payment popups that need a real BrowserWindow for postMessage.
      // Regular target="_blank" links (disposition 'foreground-tab') stay denied —
      // the renderer's new-window event handles them as new browser tabs.
      if (details.disposition === 'new-window' && /^https?:\/\//i.test(details.url)) {
        // Don't override webPreferences — Electron internally sets opener references
        // for window.opener cross-process proxying. Overriding replaces those via
        // shallow merge, breaking postMessage back to the webview (needed for OAuth).
        // The popup inherits the webview's session (persist:browser-tabs) automatically,
        // and sandbox/contextIsolation/nodeIntegration already default to secure values.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
          },
        }
      }
      return { action: 'deny' }
    })
    // Track child popup windows so we can clean up when the webview is destroyed
    const childWindows = new Set<Electron.BrowserWindow>()
    wc.on('did-create-window', (childWindow) => {
      childWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      childWindows.add(childWindow)
      childWindow.on('closed', () => childWindows.delete(childWindow))
    })
    wc.once('destroyed', () => {
      for (const w of childWindows) {
        if (!w.isDestroyed()) w.close()
      }
      childWindows.clear()
    })
    wc.on('will-frame-navigate', (event) => {
      if (isBlockedScheme(event.url) || shouldBlockDesktopHandoffUrl(event.url)) {
        event.preventDefault()
      }
    })

    let spoofingReady = false
    let spoofingPending = false
    const ensureDesktopHandoffSpoofing = async () => {
      if (spoofingReady || spoofingPending) return
      spoofingPending = true
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
        await wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
          userAgent: _chromeUa,
          userAgentMetadata: {
            brands: [
              { brand: 'Google Chrome', version: _chromiumVersion },
              { brand: 'Chromium', version: _chromiumVersion },
              { brand: 'Not_A Brand', version: '8' },
            ],
            fullVersionList: [
              { brand: 'Google Chrome', version: `${_chromiumVersion}.0.0.0` },
              { brand: 'Chromium', version: `${_chromiumVersion}.0.0.0` },
              { brand: 'Not_A Brand', version: '8.0.0.0' },
            ],
            mobile: false,
            platform: _uaPlatform,
            platformVersion: _uaPlatformVersion,
            architecture: process.arch === 'arm64' ? 'arm' : 'x86',
            model: '',
            bitness: '64',
          },
        })
        spoofingReady = true
      } catch {
        // Best-effort spoofing; fallback session/user-agent overrides remain active.
        spoofingReady = false
      } finally {
        spoofingPending = false
      }
    }

    const maybeApplyDesktopHandoffHardening = () => {
      // Respect the per-panel setting and avoid global side-effects for unrelated webviews.
      const desktopHandoffPolicy = webviewDesktopHandoffPolicy.get(wc.id)
      if (!desktopHandoffPolicy) return
      void ensureDesktopHandoffSpoofing()
      wc.executeJavaScript(WEBVIEW_INIT_SCRIPT).catch(() => {})
    }

    wc.on('did-start-navigation', (_event, _navigationUrl, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      maybeApplyDesktopHandoffHardening()
    })
    wc.on('did-navigate', () => {
      maybeApplyDesktopHandoffHardening()
    })
    wc.once('destroyed', () => {
      webviewDesktopHandoffPolicy.delete(wc.id)
      webviewDesktopHandoffPolicyCleanupRegistered.delete(wc.id)
      try {
        if (wc.debugger.isAttached()) wc.debugger.detach()
      } catch {
        // ignore
      }
    })
  }

  // will-navigate: same-frame main navigation (link clicks, window.location, etc.)
  // Covers both webview type AND 'window' type (popup windows spawned by allowpopups webviews).
  wc.on('will-navigate', (event, url) => {
    if (isBlockedScheme(url) || shouldBlockDesktopHandoffUrl(url)) {
      event.preventDefault()
    }
  })
  // will-redirect: server-side HTTP redirects to external app protocols
  wc.on('will-redirect', (event, url) => {
    if (isBlockedScheme(url) || shouldBlockDesktopHandoffUrl(url)) {
      event.preventDefault()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Clean up database connection and active processes before quitting
app.on('will-quit', () => {
  oauthCallbackQueue.length = 0
  oauthCallbackWaiters.clear()
  if (linearSyncPoller) {
    clearInterval(linearSyncPoller)
    linearSyncPoller = null
  }
  if (discoveryPoller) {
    clearInterval(discoveryPoller)
    discoveryPoller = null
  }
  mcpCleanup?.()
  stopDiagnostics()
  stopIdleChecker()
  stopAutoBackup()
  killAllPtys()
  killAllProcesses()
  closeDatabase()
  closeDiagnosticsDatabase()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
