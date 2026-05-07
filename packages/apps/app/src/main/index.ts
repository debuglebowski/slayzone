
// Raise RLIMIT_NOFILE before anything else can spawn a child so every
// descendant (PTYs, ripgrep, git, renderer helpers) inherits a high soft
// limit. Best-effort: logs and continues on failure — the per-PTY sh wrapper
// in shell-env.ts still protects terminal sessions if the native addon
// can't load.
import { raiseFdLimit } from './raise-fd-limit'
const fdLimitResult = raiseFdLimit()
console.log('[fd-limit]', JSON.stringify(fdLimitResult))

import { app, shell, BrowserWindow, ipcMain, nativeTheme, session, webContents, dialog, Menu, protocol, powerMonitor, crashReporter } from 'electron'
import { join, extname, normalize, sep, resolve } from 'path'
import { homedir } from 'os'
import { readFileSync, promises as fsp, mkdirSync, appendFileSync } from 'fs'
import { electronApp, is } from '@electron-toolkit/utils'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore } from 'electron-chrome-web-store'
import { registerBrowserTab, unregisterBrowserTab, setActiveBrowserTab, clearBrowserRegistry } from './browser-registry'
import { BrowserViewManager } from './browser-view-manager'
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
import { toElectronAccelerator, matchesElectronInput, shortcutDefinitions, MENU_SHORTCUT_DEFAULTS, type ElectronInput } from '@slayzone/shortcuts'

// Mutable shortcut overrides — updated from DB when shortcuts change.
// Module-scope so both createMainWindow (before-input-event) and app.whenReady (menu) can access.
let currentOverrides: Record<string, string | null> = {}

/** Resolve effective keys for a shortcut ID, checking overrides then defaults. */
function getEffectiveKeys(id: string, overrides: Record<string, string | null>): string | null {
  if (id in overrides) return overrides[id]
  const def = shortcutDefinitions.find(d => d.id === id)
  return def?.defaultKeys ?? null
}

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

// Start crash reporter before any windows or native modules can fault.
// Local-only: minidumps land in app.getPath('crashDumps'); next boot scans + logs them.
crashReporter.start({
  uploadToServer: false,
  productName: 'slayzone',
  companyName: 'slayzone',
  ignoreSystemCrashHandler: false
})

// Strip Electron/app tokens from the global UA fallback so ALL sessions, popups, and
// subrequests present as vanilla Chromium — not just the explicitly-configured sessions.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/\S+/i, '')
  .replace(/\s*slayzone\/\S+/i, '')

// Use macOS/system CA for TLS instead of Chromium's bundled CA.
// This makes the TLS fingerprint match system browsers more closely.
app.commandLine.appendSwitch('tls-use-system-ca')

// Prevent navigator.webdriver=true — Electron sets this by default which is
// the #1 signal BotGuard uses to block Google sign-in.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// Enable remote debugging in dev (port 0 = OS-assigned, avoids conflicts with other dev instances)
if (is.dev && !isPlaywright) {
  app.commandLine.appendSwitch('remote-debugging-port', '0')
}

// Redirect userData early so Electron's lock, cookies, GPU cache, crash dumps,
// and all per-instance state land in the right dir. Honors SLAYZONE_STORE_DIR
// override on every platform; otherwise on Linux migrates ~/.config/slayzone →
// ~/.local/state/slayzone (XDG). On macOS/Windows w/o override, Electron's
// default already matches getStateDir(), so no setPath is needed.
import { migrateXdgIfNeeded, migrateCliBinIfNeeded, getStateDir, getDataRoot, installCli, checkCliInstalled, getCliBinTarget, getManualInstallHint } from '@slayzone/platform'
{
  const override = process.env.SLAYZONE_STORE_DIR
  let target: string | null = null
  if (override) {
    target = override
  } else if (process.platform === 'linux') {
    const result = migrateXdgIfNeeded()
    if (!result.failed) target = getStateDir()
  }
  if (target) {
    mkdirSync(target, { recursive: true })
    app.setPath('userData', target)
  }
}

import icon from '../../resources/icon.png?asset'
import logoSolid from '../../resources/logo-solid.svg?asset'
import { getDatabase, closeDatabase, getDiagnosticsDatabase, closeDiagnosticsDatabase } from './db'
import { runMigrations, LATEST_MIGRATION_VERSION } from './db/migrations'
import { normalizeProjectStatusData } from './db/status-normalization'
import { migrateV127DiskDir } from './db/v127-disk-migration'
import { buildBackupOps, startAutoBackup, stopAutoBackup, createPreMigrationBackup } from './backup'
// Domain handlers
import { handleTerminalStateChange } from '@slayzone/projects/server'
import { configureTaskRuntimeAdapters, pathExists, saveTempImage, closeArtifactWatcher, startArtifactWatcher } from '@slayzone/task/electron'
import { BlobStore, betterSqliteTxn, seedInitialVersions } from '@slayzone/task-artifacts/server'
import { getExtensionFromTitle } from '@slayzone/task/shared'
import { wireNativeThemeBridge } from '@slayzone/settings/electron'
import { createPtyOps, ptyEvents, buildUsageOps, killAllPtys, killPtysByTaskId, electronOnTaskReachedTerminal, startIdleChecker, stopIdleChecker, getPtyPids, onSessionChange, onGlobalStateChange, onPtyInputSubmit, createChatOps, createChatQueueOps, chatEvents, chatQueueEvents, shutdownChatTransports, setOnHostKillHandler, broadcastRespawnRequest, backfillChatModes } from '@slayzone/terminal/electron'
import { setDatabase } from '@slayzone/terminal/electron'
import { onTaskReachedTerminal, setOnTaskReachedTerminalHandler, syncTerminalModes } from '@slayzone/terminal/server'
import { setProviderLastKilledAt, type ProviderConfig } from '@slayzone/task/shared'
import { attachFloatingAgent, setupFloatingAgent } from './floating-agent'
import { attachTaskWindows, setupTaskWindows } from './task-windows'
import { closeGitWatcher } from '@slayzone/worktrees/server'
import { initChatTurnSubscriber, initPtyTurnSubscriber } from '@slayzone/agent-turns/server'
import { registerDiagnosticsHandlers, registerProcessDiagnostics, recordDiagnosticEvent, stopDiagnostics, setIpcSuccessHook } from '@slayzone/diagnostics/electron'
import { detectPreviousCrash, writeBootStub, writeCleanShutdownSentinel, scanCrashDumps } from './lifecycle/sentinel'
import { acquireLockWithSelfHeal, lockOutcomeIsAcquired, type LockOutcome } from './lifecycle/single-instance'
import { IPC_TELEMETRY_MAP } from '@slayzone/telemetry/shared'
import { initAiConfigOps } from '@slayzone/ai-config/server'
import { setAppDeps, setProcessesDeps, setPtyDeps, setChatDeps } from '@slayzone/transport/server'
import { ElectronStorageAdapter } from '@slayzone/integrations/electron'
import { initIntegrationOps, ensureIntegrationSchema, startSyncPoller, pushTaskAfterEdit, pushNewTaskToProviders, pushArchiveToProviders, pushUnarchiveToProviders, startDiscoveryPoller, resetSyncFlags, setStorageAdapter } from '@slayzone/integrations/server'
import { closeAllFileWatchers } from '@slayzone/file-editor/server'
import { AutomationEngine, automationsEvents } from '@slayzone/automations/server'
import { captureBrowserViewScreenshot } from './screenshot'
import { writeFilePaths, readFilePaths, hasFilePaths } from './clipboard-handlers'
import { setProcessManagerWindow, initProcessManager, createProcess, spawnProcess, updateProcess, stopProcess, killProcess, restartProcess, listForTask, listAllProcesses, killTaskProcesses, killAllProcesses, processEvents } from './process-manager'
import { createStatsPoller } from './pid-stats'
import { buildExportImportOps } from './export-import'
import { getLocalLeaderboardStats } from './leaderboard'
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
const browserViewManager = new BrowserViewManager()
// Inline DevTools BrowserView system removed — using native docked DevTools via WebContentsView
let linearSyncPoller: NodeJS.Timeout | null = null
let discoveryPoller: NodeJS.Timeout | null = null
let mcpCleanup: (() => void) | null = null
let trpcCleanup: (() => void) | null = null
type OAuthCallbackPayload = { code?: string; error?: string }
const oauthCallbackQueue: OAuthCallbackPayload[] = []
const oauthCallbackWaiters = new Set<(payload: OAuthCallbackPayload) => void>()
let mainWindowReady = false
let rendererDataReady = false
let rendererReloading = false
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
type AppZoomCommand = 'in' | 'out' | 'reset'
const APP_ZOOM_LEVEL_STEP = 0.5
const APP_ZOOM_LEVEL_MIN = -8
const APP_ZOOM_LEVEL_MAX = 9
const SUPPORTED_PROTOCOL_SCHEMES = new Set([APP_PROTOCOL_SCHEME])
const OAUTH_DEEP_LINK_REDIRECT_URI = `${APP_PROTOCOL_SCHEME}://auth/callback`
const OAUTH_CALLBACK_TIMEOUT_MS = 120_000

const BOOT_START_MS = performance.now()
let bootLastStepMs = BOOT_START_MS
const bootSteps: { step: string; t: number; delta: number }[] = []
const isBootDebug = (): boolean => is.dev && process.env.SLAYZONE_DEBUG_BOOT === '1'

// Optional sync file sink. stdout capture in Playwright drops data emitted
// before its 'data' listener attaches, so writing direct to a known file
// guarantees we keep the early-boot lines (db init, migrations, etc.).
function bootLogFilePath(): string | null {
  return process.env.SLAYZONE_BOOT_LOG_PATH ?? null
}

function logBoot(step: string): void {
  if (!isBootDebug()) return
  const now = performance.now()
  const t = Math.round(now - BOOT_START_MS)
  const delta = Math.round(now - bootLastStepMs)
  bootLastStepMs = now
  bootSteps.push({ step, t, delta })
  const line = `[boot] t=${String(t).padStart(5)}ms Δ=${String(delta).padStart(5)}ms ${step}`
  console.log(line)
  const file = bootLogFilePath()
  if (file) {
    try { appendFileSync(file, line + '\n') } catch { /* best effort */ }
  }
}

function dumpBootSummary(label: string): void {
  if (!isBootDebug() || bootSteps.length === 0) return
  const sorted = [...bootSteps].sort((a, b) => b.delta - a.delta).slice(0, 12)
  const last = bootSteps[bootSteps.length - 1]
  const lines: string[] = []
  lines.push(`[boot] ── summary @ ${label} ── total=${last.t}ms steps=${bootSteps.length}`)
  lines.push(`[boot] top gaps:`)
  for (const s of sorted) {
    lines.push(`[boot]   Δ=${String(s.delta).padStart(5)}ms  t=${String(s.t).padStart(5)}ms  ${s.step}`)
  }
  for (const l of lines) console.log(l)
  const file = bootLogFilePath()
  if (file) {
    try { appendFileSync(file, lines.join('\n') + '\n') } catch { /* best effort */ }
  }
}

function applyAppZoom(command: AppZoomCommand): number {
  if (!mainWindow || mainWindow.isDestroyed()) return 1

  const wc = mainWindow.webContents
  const nextLevel = command === 'reset'
    ? 0
    : Math.max(
        APP_ZOOM_LEVEL_MIN,
        Math.min(
          APP_ZOOM_LEVEL_MAX,
          wc.zoomLevel + (command === 'in' ? APP_ZOOM_LEVEL_STEP : -APP_ZOOM_LEVEL_STEP)
        )
      )

  wc.zoomLevel = nextLevel
  const zoomFactor = wc.zoomFactor
  wc.send('app:zoom-factor-changed', zoomFactor)
  return zoomFactor
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
  logBoot('main window shown')
  dumpBootSummary('main window shown')
}

// InlineDevToolsBounds, normalizeInlineDevToolsBounds, ensureInlineDevToolsView, removeInlineDevToolsView removed
// DevTools now docked natively inside WebContentsView via browser-view-manager

// tuneInlineDevToolsFrontend and scheduleDisableDevToolsDeviceToolbar removed

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
let lockOutcome: LockOutcome = { kind: 'acquired' }
if (shouldEnforceSingleInstanceLock) {
  lockOutcome = acquireLockWithSelfHeal()
}
const gotSingleInstanceLock = !shouldEnforceSingleInstanceLock || lockOutcomeIsAcquired(lockOutcome)
if (!gotSingleInstanceLock) {
  console.error('[app] Failed to acquire single-instance lock; quitting duplicate instance', lockOutcome)
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

function getCliSrc(): string {
  return is.dev
    ? join(app.getAppPath(), '../cli/bin/slay')
    : join(process.resourcesPath, 'bin', 'slay')
}

async function installSlayCli(): Promise<void> {
  const result = await installCli(getCliSrc())
  if (result.ok) {
    let msg = `'slay' installed to ${result.path}`
    if (result.pathNotInPATH) msg += `\n\nNote: ${getCliBinTarget()} dir is not in your PATH. Add it to use 'slay' from any terminal.`
    dialog.showMessageBox({ message: msg })
  } else if (result.elevationCancelled) {
    // User dismissed OS password dialog — no additional dialog needed
  } else if (result.permissionDenied) {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Permission denied',
      detail: `Run this in Terminal to install manually:\n\n${getManualInstallHint(getCliSrc())}`
    })
  } else {
    dialog.showErrorBox('Install failed', result.error ?? 'Unknown error')
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
    logBoot('splash window shown')
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
    logBoot('renderer data-ready FALLBACK (5s timeout fired)')
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

  browserViewManager.setMainWindow(mainWindow)
  // .once: Chromium re-emits 'ready-to-show' a second time ~400ms after first
  // paint (compositor surface re-allocates after React mount). The second fire
  // is benign — handler is idempotent — but using .once keeps the boot
  // timeline clean and avoids redundant idle-checker init.
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) startIdleChecker(mainWindow)
    mainWindowReady = true
    logBoot('main window ready-to-show')
    tryShowMainWindow()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only open http/https/mailto externally — never shell.openExternal a figma:// or other app protocol
    if (/^https?:\/\//i.test(details.url) || details.url.startsWith('mailto:')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // Floating agent panel: register main window with state machine adapter
  attachFloatingAgent(mainWindow)
  attachTaskWindows(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Recover from renderer crashes (black screen) by forcing a fresh navigation.
  // webContents.reload() fails silently after render-process-gone (stale frame handle),
  // so we use loadURL/loadFile which creates a new frame.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason, details.exitCode)
    rendererReloading = true
    browserViewManager.reset()
    if (!mainWindow || mainWindow.isDestroyed()) return
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      console.log('[renderer] reloading after crash...')
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
      } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
      }
    }, 500)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    // Clean up orphaned WebContentsViews from previous renderer session
    browserViewManager.reset()
    if (rendererReloading) {
      console.log('[renderer] reload complete')
      rendererReloading = false
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[renderer] unresponsive')
  })

  mainWindow.webContents.on('responsive', () => {
    console.log('[renderer] responsive again')
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const ei = input as unknown as ElectronInput

    if (matchesElectronInput(ei, getEffectiveKeys('go-home', currentOverrides))) {
      event.preventDefault()
      mainWindow?.webContents.send('app:go-home')
      return
    }

    // Check project-settings before global-settings (shift variant first)
    if (matchesElectronInput(ei, getEffectiveKeys('project-settings', currentOverrides))) {
      event.preventDefault()
      emitOpenProjectSettings()
      return
    }

    if (matchesElectronInput(ei, getEffectiveKeys('global-settings', currentOverrides))) {
      event.preventDefault()
      emitOpenSettings()
      return
    }

    if (matchesElectronInput(ei, getEffectiveKeys('terminal-screenshot', currentOverrides))) {
      event.preventDefault()
      mainWindow?.webContents.send('app:screenshot-trigger')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('reload-browser', currentOverrides))) {
      event.preventDefault()
      mainWindow?.webContents.send('app:reload-browser')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('reload-app', currentOverrides))) {
      event.preventDefault()
      mainWindow?.webContents.send('app:reload-app')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('agent-panel', currentOverrides))) {
      event.preventDefault()
      mainWindow?.webContents.send('app:toggle-agent-panel')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('agent-status-panel', currentOverrides))) {
      event.preventDefault()
      mainWindow?.webContents.send('app:toggle-agent-status-panel')
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
    if (rendererReloading) return
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
  logBoot('db opened')
  await createPreMigrationBackup(db, LATEST_MIGRATION_VERSION)
  logBoot('pre-migration backup done')
  runMigrations(db)
  logBoot('migrations applied')
  normalizeProjectStatusData(db)

  // v127 disk-dir migration: assets/ → artifacts/. Idempotent.
  // Earlier v127 builds shipped a no-op rename (both vars = 'artifacts') that
  // left user content orphaned in assets/. This block recovers from that and
  // also handles fresh upgrades. See db/v127-disk-migration.ts.
  {
    const dataDir = app.getPath('userData')
    try {
      const report = migrateV127DiskDir(join(dataDir, 'assets'), join(dataDir, 'artifacts'))
      if (report.mode !== 'noop') {
        console.log(`[migration v127] disk: mode=${report.mode} taskDirsMoved=${report.taskDirsMoved} filesMoved=${report.filesMoved} conflicts=${report.conflicts} oldDirRemoved=${report.oldDirRemoved}`)
      }
    } catch (e) {
      console.error('[migration v127] disk dir migration failed', e)
    }
  }
  logBoot('v127 disk migration done')

  // Seed initial artifact versions (v1) for any artifacts without history. Idempotent.
  {
    const dataDir = app.getPath('userData')
    const artifactsDir = join(dataDir, 'artifacts')
    const blobStore = new BlobStore(dataDir)
    const txnRunner = betterSqliteTxn(db)
    const seedReport = seedInitialVersions(db, txnRunner, blobStore, {
      resolveFilePath: (row) => {
        const ext = getExtensionFromTitle(row.title) || '.txt'
        return join(artifactsDir, row.task_id, `${row.id}${ext}`)
      }
    })
    if (seedReport.seeded > 0 || seedReport.skippedMissing > 0) {
      console.log(`[artifact-versions] seeded=${seedReport.seeded} skippedMissing=${seedReport.skippedMissing}`)
    }
  }
  logBoot('artifact versions seeded')
  const diagDb = getDiagnosticsDatabase()
  logBoot('diagnostics db opened')
  const isLabEnabled = (key: string): boolean => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return is.dev || isPlaywright
    return row.value === '1'
  }
  logBoot('database init complete')

  // Lifecycle: detect prior crash via boot sentinel + arm sentinel for this run.
  // Pure fs (no DB needed). recordDiagnosticEvent buffers until handlers register.
  const { crashed: previousCrashed, prevBoot } = detectPreviousCrash()
  writeBootStub()
  recordDiagnosticEvent({
    level: 'info', source: 'main', event: 'app.boot.start',
    payload: { version: app.getVersion(), pid: process.pid, platform: process.platform }
  })
  if (previousCrashed && prevBoot) {
    const minidumps = scanCrashDumps(prevBoot.ts)
    recordDiagnosticEvent({
      level: 'error', source: 'main', event: 'app.crash.detected_on_next_boot',
      payload: {
        prevBootTs: prevBoot.ts,
        prevPid: prevBoot.pid,
        prevVersion: prevBoot.version,
        currentVersion: app.getVersion(),
        minidumps
      }
    })
  }
  if (lockOutcome.kind !== 'acquired') {
    recordDiagnosticEvent({
      level: lockOutcome.kind === 'recovered' ? 'warn' : 'info',
      source: 'main',
      event: `app.singleinstance.${lockOutcome.kind}`,
      payload: lockOutcome
    })
  }

  // Skip onboarding in Playwright — tested explicitly in 02-onboarding.spec.ts
  if (isPlaywright) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')").run()
  }

  registerProcessDiagnostics(app)
  logBoot('process diagnostics registered')

  // Migrate CLI symlink from /usr/local/bin to ~/.local/bin on Linux
  if (process.platform === 'linux') {
    const cliMigration = migrateCliBinIfNeeded(getCliSrc())
    if (cliMigration.status === 'migrated-old-kept') {
      const shown = db.prepare('SELECT value FROM settings WHERE key = ?').get('cli_migration_dialog_shown') as { value: string } | undefined
      if (!shown) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('cli_migration_dialog_shown', '1')
        dialog.showMessageBox({
          type: 'info',
          title: 'CLI symlink migrated',
          message: `The slay CLI was installed at ${cliMigration.newPath}, but the old symlink at ${cliMigration.oldPath} couldn't be removed.`,
          detail: `Run: sudo rm ${cliMigration.oldPath}`,
        })
      }
    }
  }

  // Load and apply persisted theme BEFORE creating window to prevent flash
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('theme') as
    | { value: string }
    | undefined
  const savedTheme = row?.value as 'light' | 'dark' | 'system' | undefined
  nativeTheme.themeSource = savedTheme ?? 'dark'
  logBoot('theme loaded')

  function getMenuAccelerator(id: string, overrides: Record<string, string | null>): string | undefined {
    const keys = id in overrides ? overrides[id] : (MENU_SHORTCUT_DEFAULTS[id] ?? null)
    return toElectronAccelerator(keys) ?? undefined
  }

  function buildAppMenu(overrides: Record<string, string | null>): void {
    if (process.platform !== 'darwin') return

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
            accelerator: getMenuAccelerator('global-settings', overrides),
            click: () => emitOpenSettings()
          },
          {
            label: 'Project Settings...',
            accelerator: getMenuAccelerator('project-settings', overrides),
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
            accelerator: getMenuAccelerator('new-temp-task', overrides),
            click: () => emitNewTemporaryTask()
          },
          {
            label: 'Sync Detected Session ID',
            accelerator: getMenuAccelerator('sync-session-id', overrides),
            click: () => mainWindow?.webContents.send('app:sync-session-id')
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
            label: 'Reload Browser',
            accelerator: 'CmdOrCtrl+R',
            registerAccelerator: false,
            click: () => mainWindow?.webContents.send('app:reload-browser')
          },
          {
            label: 'Reload App',
            accelerator: 'CmdOrCtrl+Shift+R',
            registerAccelerator: false,
            click: () => mainWindow?.webContents.send('app:reload-app')
          },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          {
            label: 'Actual Size',
            accelerator: 'CmdOrCtrl+0',
            registerAccelerator: false,
            click: () => applyAppZoom('reset')
          },
          {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+Plus',
            registerAccelerator: false,
            click: () => applyAppZoom('in')
          },
          {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            registerAccelerator: false,
            click: () => applyAppZoom('out')
          },
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
            accelerator: getMenuAccelerator('close-tab', overrides),
            click: () => {
              const focused = BrowserWindow.getFocusedWindow()
              // Secondary task windows + floating agent etc: just close the window itself
              if (focused && focused !== mainWindow) {
                focused.close()
                return
              }
              mainWindow?.webContents.send('app:close-current-focus')
            }
          },
          {
            label: 'Close Task',
            accelerator: getMenuAccelerator('close-task', overrides),
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

  // Set dock icon on macOS (needed for dev mode)
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }

  function loadShortcutOverrides(): Record<string, string | null> {
    const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('custom_shortcuts') as { value: string } | undefined
    return raw?.value ? JSON.parse(raw.value) : {}
  }

  currentOverrides = loadShortcutOverrides()
  buildAppMenu(currentOverrides)
  logBoot('app menu built')

  // Rebuild menu + update overrides cache whenever shortcuts change
  ipcMain.on('shortcuts:changed', () => {
    currentOverrides = loadShortcutOverrides()
    buildAppMenu(currentOverrides)
  })

  // Register diagnostics first so IPC handlers below are instrumented.
  // Flushes any events buffered before this point (boot.start, crash detect, lock outcome).
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
    requestPtyRespawn: broadcastRespawnRequest,
    onReachedTerminal: onTaskReachedTerminal,
  })
  logBoot('task runtime adapters configured')

  // Persist the host-kill timestamp into provider_config so the revive flow can
  // choose between resume (hot) and fresh conversation (cold) — see COLD_RESPAWN_MS.
  setOnHostKillHandler((taskId, mode) => {
    try {
      const row = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as
        | { provider_config: string | null }
        | undefined
      if (!row) return
      const cfg: ProviderConfig = row.provider_config ? JSON.parse(row.provider_config) : {}
      const next = setProviderLastKilledAt(cfg, mode, Date.now())
      db.prepare('UPDATE tasks SET provider_config = ? WHERE id = ?').run(JSON.stringify(next), taskId)
    } catch (err) {
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'pty.host_kill_persist_failed',
        taskId,
        message: (err as Error).message
      })
    }
  })

  // Register domain handlers (inject ipcMain and db)
  const notifyTasksChanged = (): void => { mainWindow?.webContents.send('tasks:changed') }
  // Task IPC migrated to tRPC `task.*` router (subscriptions cover changed events).
  startArtifactWatcher(join(getDataRoot(), 'artifacts'))
  logBoot('artifact watcher started')


  wireNativeThemeBridge()
  setDatabase(db)
  syncTerminalModes(db)
  setPtyDeps({
    ops: createPtyOps(db),
    events: ptyEvents,
  })
  logBoot('pty ops wired into tRPC')
  setupFloatingAgent(() => currentOverrides)
  setupTaskWindows()
  logBoot('floating agent + task windows set up')

  // Task automation: auto-move tasks on terminal state change
  onGlobalStateChange((sessionId, newState, oldState) => {
    handleTerminalStateChange(db, sessionId, newState, oldState, notifyTasksChanged, onTaskReachedTerminal)
  })

  // Expose test helpers for e2e
  if (isPlaywright) {
    ;(globalThis as Record<string, unknown>).__db = db
    ;(globalThis as Record<string, unknown>).__spawnProcess = spawnProcess
    // __restorePtyHandlers removed — tRPC procedures don't need re-registration.
  }

  setOnTaskReachedTerminalHandler(electronOnTaskReachedTerminal)
  logBoot('task-terminals handlers migrated to tRPC')
  setChatDeps({
    ops: createChatOps(db, { onChatEvent: initChatTurnSubscriber(db) }),
    queueOps: createChatQueueOps(db),
    events: chatEvents,
    queueEvents: chatQueueEvents,
  })
  // One-shot: backfill `chatMode` for tasks that pre-date the chat-mode UI so
  // upgraded users keep their current `--allow-dangerously-skip-permissions`
  // behavior instead of suddenly hitting denials.
  try {
    const stats = backfillChatModes(db)
    if (stats.updated > 0) {
      console.log(`[chat-handlers] backfillChatModes: ${stats.updated}/${stats.scanned} tasks tagged 'bypass'`)
    }
  } catch (err) {
    console.error('[chat-handlers] backfillChatModes failed:', err)
  }
  logBoot('files registered')
  // xterm-mode turn detection: every Enter press in a PTY = turn boundary.
  onPtyInputSubmit(initPtyTurnSubscriber(db))
  initAiConfigOps(db)
  logBoot('ai-config ops initialized')
  setStorageAdapter(new ElectronStorageAdapter())
  const integrationHandles = initIntegrationOps(db, { enableTestChannels: isPlaywright })
  logBoot('integration ops initialized')
  const automationEngine = new AutomationEngine(db)
  // Each automation 'changed' emit also re-fetches tasks (engine mutations
  // touch task rows). Renderer subscription `automations.onChanged` handles
  // the UI side via tRPC.
  automationsEvents.on('changed', () => notifyTasksChanged())
  automationEngine.start()
  powerMonitor.on('resume', () => automationEngine.runCatchup())
  startAutoBackup(db)

  // Wire app-level dependencies into the tRPC router
  const backupOps = buildBackupOps(db)
  const exportImportOps = buildExportImportOps(db, isPlaywright)
  const usageOps = buildUsageOps(db)
  setAppDeps({
    backupList: backupOps.list,
    backupCreate: backupOps.create,
    backupRename: backupOps.rename,
    backupDelete: backupOps.delete,
    backupRestore: backupOps.restore,
    backupGetSettings: backupOps.getSettings,
    backupSetSettings: backupOps.setSettings,
    backupRevealInFinder: backupOps.revealInFinder,
    clipboardWriteFilePaths: writeFilePaths,
    clipboardReadFilePaths: readFilePaths,
    clipboardHasFiles: hasFilePaths,
    screenshotCaptureView: (viewId: string) => captureBrowserViewScreenshot(browserViewManager, viewId),
    leaderboardGetLocalStats: () => getLocalLeaderboardStats(db),
    exportAll: exportImportOps.exportAll,
    exportProject: exportImportOps.exportProject,
    importBundle: exportImportOps.importBundle,
    testExportAllToPath: 'testExportAllToPath' in exportImportOps ? exportImportOps.testExportAllToPath : undefined,
    testExportProjectToPath: 'testExportProjectToPath' in exportImportOps ? exportImportOps.testExportProjectToPath : undefined,
    testImportFromPath: 'testImportFromPath' in exportImportOps ? exportImportOps.testImportFromPath : undefined,
    testSetTaskParent: 'testSetTaskParent' in exportImportOps ? exportImportOps.testSetTaskParent : undefined,
    usageFetch: usageOps.fetch,
    usageTest: usageOps.test,

    // files
    filesPathExists: pathExists,
    filesSaveTempImage: saveTempImage,

    // shell — same logic as ipcMain.handle('shell:open-external', ...)
    shellOpenExternal: (url: string, options?: { blockDesktopHandoff?: boolean; desktopHandoff?: { protocol?: string; hostScope?: string } }) => {
      if (!/^https?:\/\//i.test(url) && !url.startsWith('mailto:')) {
        throw new Error('Only http, https, and mailto URLs are allowed')
      }
      const desktopHandoffPolicy = (options?.desktopHandoff as DesktopHandoffPolicy | undefined) ?? (() => {
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
    },
    shellOpenPath: async (absPath: string) => {
      if (typeof absPath !== 'string' || !absPath.startsWith('/')) {
        throw new Error('absolute path required')
      }
      return shell.openPath(absPath)
    },

    // db:feedback
    feedbackListThreads: () =>
      db.prepare('SELECT id, title, discord_thread_id, created_at FROM feedback_threads ORDER BY created_at DESC').all(),
    feedbackCreateThread: (input) =>
      db.prepare('INSERT INTO feedback_threads (id, title, discord_thread_id) VALUES (?, ?, ?)').run(input.id, input.title, input.discord_thread_id),
    feedbackGetMessages: (threadId) =>
      db.prepare('SELECT id, thread_id, content, created_at FROM feedback_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId),
    feedbackAddMessage: (input) =>
      db.prepare('INSERT INTO feedback_messages (id, thread_id, content) VALUES (?, ?, ?)').run(input.id, input.thread_id, input.content),
    feedbackUpdateThreadDiscordId: (threadId, discordThreadId) =>
      db.prepare('UPDATE feedback_threads SET discord_thread_id = ? WHERE id = ?').run(discordThreadId, threadId),
    feedbackDeleteThread: (threadId) =>
      db.prepare('DELETE FROM feedback_threads WHERE id = ?').run(threadId),

    // app metadata
    appGetVersion: () => app.getVersion(),
    appGetTrpcPort: async () => {
      const g = globalThis as Record<string, unknown>
      if (typeof g.__trpcPort === 'number') return g.__trpcPort as number
      return new Promise<number>((resolve) => {
        const start = Date.now()
        const check = (): void => {
          const port = (globalThis as Record<string, unknown>).__trpcPort
          if (typeof port === 'number') resolve(port)
          else if (Date.now() - start > 5000) resolve(0)
          else setTimeout(check, 50)
        }
        check()
      })
    },
    appIsTestsPanelEnabled: () => isLabEnabled('labs_tests_panel'),
    appIsJiraIntegrationEnabled: () => isLabEnabled('labs_jira_integration'),
    appIsLoopModeEnabled: () => isLabEnabled('labs_loop_mode'),
    appGetZoomFactor: () => mainWindow?.webContents.zoomFactor ?? 1,
    appCheckCliInstalled: () => checkCliInstalled(),
    appInstallCli: () => installCli(getCliSrc()),
    appAdjustZoom: (command) => applyAppZoom(command),
    appRestartForUpdate: () => restartForUpdate(),
    appCheckForUpdates: () => checkForUpdates(),
    appGetProtocolClientStatus: () => protocolClientStatus,
    appGetRendererZoomFactor: () => mainWindow?.webContents.zoomFactor ?? null,
    appWindowGetContentBounds: () => mainWindow?.getContentBounds() ?? null,
    appWindowGetDisplayScaleFactor: () => {
      const cb = mainWindow?.getContentBounds()
      if (!cb) return 1
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { screen } = require('electron') as typeof import('electron')
      const display = screen.getDisplayMatching(cb)
      return display.scaleFactor
    },
    browser: {
      createView: (opts) => browserViewManager.createView(opts as never),
      destroyView: (viewId) => browserViewManager.destroyView(viewId),
      destroyAllForTask: (taskId) => browserViewManager.destroyAllForTask(taskId),
      setBounds: (viewId, bounds) => browserViewManager.setBounds(viewId, bounds as never),
      setVisible: (viewId, visible) => browserViewManager.setVisible(viewId, visible),
      hideAll: () => browserViewManager.hideAll(),
      showAll: () => browserViewManager.showAll(),
      setHandoffPolicy: (viewId, policy) => browserViewManager.setHandoffPolicy(viewId, policy as never),
      navigate: (viewId, url) => browserViewManager.navigate(viewId, url),
      goBack: (viewId) => browserViewManager.goBack(viewId),
      goForward: (viewId) => browserViewManager.goForward(viewId),
      reload: (viewId, ignoreCache) => browserViewManager.reload(viewId, ignoreCache),
      stop: (viewId) => browserViewManager.stop(viewId),
      executeJs: (viewId, code) => browserViewManager.executeJs(viewId, code),
      insertCss: (viewId, css) => browserViewManager.insertCss(viewId, css),
      removeCss: (viewId, key) => browserViewManager.removeCss(viewId, key),
      setZoom: (viewId, factor) => browserViewManager.setZoom(viewId, factor),
      focus: (viewId) => browserViewManager.focus(viewId),
      findInPage: (viewId, text, options) => browserViewManager.findInPage(viewId, text, options as never),
      stopFindInPage: (viewId, action) => browserViewManager.stopFindInPage(viewId, action),
      setKeyboardPassthrough: (viewId, enabled) => browserViewManager.setKeyboardPassthrough(viewId, enabled),
      sendInputEvent: (viewId, input) => browserViewManager.sendInputEvent(viewId, input as never),
      openDevTools: (viewId, mode) => browserViewManager.openDevTools(viewId, mode),
      closeDevTools: (viewId) => browserViewManager.closeDevTools(viewId),
      isDevToolsOpen: (viewId) => browserViewManager.isDevToolsOpen(viewId),
      getUrl: (viewId) => browserViewManager.getUrl(viewId),
      getBounds: (viewId) => browserViewManager.getBounds(viewId),
      getZoomFactor: (viewId) => browserViewManager.getZoomFactor(viewId),
      getActualNativeBounds: (viewId) => browserViewManager.getActualNativeBounds(viewId),
      getViewVisible: (viewId) => browserViewManager.getViewVisible(viewId),
      getViewsForTask: (taskId) => browserViewManager.getViewsForTask(taskId),
      getAllViewIds: () => browserViewManager.getAllViewIds(),
      listViews: () => browserViewManager.listViews(),
      getNativeChildViewCount: () => browserViewManager.getNativeChildViewCount(),
      isAllHidden: () => browserViewManager.isAllHidden(),
      isFocused: (viewId) => browserViewManager.isFocused(viewId),
      isViewNativelyVisible: (viewId) => browserViewManager.isViewNativelyVisible(viewId),
      getPartition: (viewId) => browserViewManager.getPartition(viewId),
      getWebContentsId: (viewId) => browserViewManager.getWebContentsId(viewId),
      activateExtension: (extensionId) => {
        try {
          const ext = browserSession.getExtension(extensionId)
          if (!ext) return false
          const activeWc = browserViewManager.getActiveWebContents()
          if (!activeWc) return false
          const api = (chromeExtensions as unknown as { api: { browserAction?: { activate?: (a: unknown, b: unknown) => void } } }).api
          if (api?.browserAction?.activate) {
            api.browserAction.activate({ type: 'click' }, { extensionId, tabId: activeWc.id })
            return true
          }
          const ctx = (chromeExtensions as unknown as { ctx: { router?: { invoke: (...args: unknown[]) => void } } }).ctx
          if (ctx?.router) {
            ctx.router.invoke(activeWc, 'browserAction.activate', { eventType: 'click', extensionId })
            return true
          }
          return false
        } catch (err) {
          console.warn('[browser:activate-extension] Failed:', err)
          return false
        }
      },
      getExtensions: () => browserSession.getAllExtensions().map(ext => ({
        id: ext.id, name: ext.name, version: ext.manifest.version,
        manifestVersion: typeof ext.manifest.manifest_version === 'number' ? ext.manifest.manifest_version : undefined,
        icon: ext.manifest.icons ? `crx://extension-icon/${ext.id}/${Object.values(ext.manifest.icons).pop()}` : undefined,
      })),
      loadExtension: async () => {
        if (!mainWindow) return null
        const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Chrome Extension Directory' })
        if (result.canceled || !result.filePaths[0]) return null
        try {
          const ext = await browserSession.loadExtension(result.filePaths[0])
          saveExtensionPaths()
          return { id: ext.id, name: ext.name }
        } catch (err) {
          return { error: String(err) }
        }
      },
      removeExtension: (extensionId) => {
        browserSession.removeExtension(extensionId)
        saveExtensionPaths()
        return undefined
      },
      discoverBrowserExtensions: async () => {
        const appSupport = join(homedir(), 'Library', 'Application Support')
        const knownBrowsers = [
          { name: 'Chrome', dir: 'Google/Chrome/Default/Extensions' },
          { name: 'Arc', dir: 'Arc/User Data/Default/Extensions' },
          { name: 'Brave', dir: 'BraveSoftware/Brave-Browser/Default/Extensions' },
          { name: 'Edge', dir: 'Microsoft Edge/Default/Extensions' },
          { name: 'Chromium', dir: 'Chromium/Default/Extensions' },
          { name: 'Vivaldi', dir: 'Vivaldi/Default/Extensions' },
        ]
        const alreadyLoaded = new Set(browserSession.getAllExtensions().map(e => e.id))
        const results: { name: string; extensions: { id: string; name: string; version: string; path: string; alreadyImported: boolean; manifestVersion?: number }[] }[] = []
        for (const browser of knownBrowsers) {
          const extDir = join(appSupport, browser.dir)
          let entries: string[]
          try { entries = await fsp.readdir(extDir) } catch { continue }
          const extensions: typeof results[0]['extensions'] = []
          for (const id of entries) {
            if (id === 'Temp' || id.startsWith('.')) continue
            const idDir = join(extDir, id)
            let versions: string[]
            try { versions = await fsp.readdir(idDir) } catch { continue }
            const ver = versions.sort().pop()
            if (!ver) continue
            const extPath = join(idDir, ver)
            try {
              const manifest = JSON.parse(await fsp.readFile(join(extPath, 'manifest.json'), 'utf-8'))
              let name: string = manifest.name || id
              if (name.startsWith('__MSG_')) {
                const key = name.slice(6, -2)
                for (const lang of ['en', 'en_US', 'en_GB']) {
                  try {
                    const msgs = JSON.parse(await fsp.readFile(join(extPath, '_locales', lang, 'messages.json'), 'utf-8'))
                    if (msgs[key]?.message) { name = msgs[key].message; break }
                  } catch { /* try next lang */ }
                }
              }
              extensions.push({
                id, name, version: manifest.version || '?', path: extPath,
                alreadyImported: alreadyLoaded.has(id),
                manifestVersion: typeof manifest.manifest_version === 'number' ? manifest.manifest_version : undefined,
              })
            } catch { /* skip */ }
          }
          if (extensions.length > 0) results.push({ name: browser.name, extensions })
        }
        return results
      },
      importExtension: async (extPath: string) => {
        try {
          const ext = await browserSession.loadExtension(extPath)
          saveExtensionPaths()
          return { id: ext.id, name: ext.name }
        } catch (err) {
          return { error: String(err) }
        }
      },
      reparentToCurrentWindow: (viewId) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) browserViewManager.reparentView(viewId, win)
      },
    },
    webview: {
      registerBrowserTab,
      unregisterBrowserTab,
      setActiveBrowserTab,
      // Other webview methods stay as IPC for now — closure-scoped state
      // (registeredWebviews/keyboardPassthroughWebviews/policies) lives in
      // inline handlers; refactor would require a webview-shortcuts module.
      registerShortcuts: () => {},
      setKeyboardPassthrough: () => {},
      setDesktopHandoffPolicy: () => false,
      openDevToolsBottom: async () => false,
      openDevToolsDetached: async () => false,
      closeDevTools: async () => false,
      isDevToolsOpened: () => false,
      disableDeviceEmulation: () => false,
    },
    authGithubSystemSignIn: async (input) => {
      try {
        if (!input?.convexUrl) return { ok: false, error: 'Convex URL is required' }
        if (input.redirectTo !== OAUTH_DEEP_LINK_REDIRECT_URI) {
          return { ok: false, error: `Unsupported redirect URI: ${input.redirectTo}` }
        }
        if (oauthCallbackWaiters.size > 0) {
          return { ok: false, error: 'An OAuth sign-in flow is already in progress' }
        }
        oauthCallbackQueue.length = 0
        const start = await requestGithubSignInStart(input.convexUrl, input.redirectTo)
        await shell.openExternal(start.redirect)
        const callback = await waitForOAuthCallback(OAUTH_CALLBACK_TIMEOUT_MS)
        if (callback.error) {
          return { ok: false, verifier: start.verifier, error: callback.error }
        }
        if (!callback.code) {
          return { ok: false, verifier: start.verifier, error: 'GitHub sign-in failed — no authorization code returned. Try again or use a different browser.' }
        }
        return { ok: true, verifier: start.verifier, code: callback.code }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'GitHub sign-in failed' }
      }
    },
  })
  logBoot('app-level deps wired into tRPC')

  // Start MCP server off the boot critical path. The dynamic import resolves
  // a heavy module graph (~70ms sync work even though it returns a Promise),
  // and nothing on first paint depends on the server being listening — the
  // CLI discovers the port via settings and the renderer doesn't talk to it.
  setImmediate(() => {
    logBoot('mcp server import dispatched')
    import('./mcp-server').then((mod) => {
      mod.startMcpServer(db, { automationEngine })
      mcpCleanup = () => mod.stopMcpServer()
      logBoot('mcp server started')
    }).catch((err) => {
      console.error('[MCP] Failed to start server:', err)
    })
  })

  setImmediate(() => {
    logBoot('trpc server import dispatched')
    import('@slayzone/transport/server').then((mod) => {
      mod.startTrpcServer({ db, dataRoot: getDataRoot(), automationEngine })
      trpcCleanup = () => mod.stopTrpcServer()
      logBoot('trpc server started')
    }).catch((err) => {
      console.error('[tRPC] Failed to start server:', err)
    })
  })

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
    // slz-file:///path/to/file → /path/to/file (strip query string used for cache busting)
    const rawPath = decodeURIComponent(request.url.replace(/^slz-file:\/\//, ''))
    const filePath = normalize(rawPath.split('?')[0])

    // Block path traversal outside user home directory
    if (!filePath.startsWith(userHome + sep)) {
      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Forbidden</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui;background:#1a1a1a;color:#888}
div{text-align:center}h1{font-size:14px;font-weight:500;color:#aaa}p{font-size:12px;margin:8px 0 0;word-break:break-all;max-width:400px}</style>
</head><body><div><h1>Access denied</h1><p>Path outside home directory</p></div></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
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
        headers: { 'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' }
      })
    } catch {
      const escaped = filePath.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>File not found</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui;background:#1a1a1a;color:#888}
div{text-align:center}h1{font-size:14px;font-weight:500;color:#aaa}p{font-size:12px;margin:8px 0 0;word-break:break-all;max-width:400px}</style>
</head><body><div><h1>File not found</h1><p>${escaped}</p></div></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      )
    }
  }
  const webPanelSession = session.fromPartition('persist:web-panels')
  webPanelSession.setUserAgent(_chromeUa)

  // Block external protocol navigation from inside webview pages (e.g. window.location = 'figma://...')
  // session.protocol.handle only intercepts loadURL from the main process — page-initiated
  // navigation bypasses it. A session preload patches window.open/location before page JS runs.
  // Register preload only for web-panels session (old webview-based panels).
  // Browser-tabs session (WebContentsView) uses applySpoofing() per-view instead,
  // which skips Google domains. The preload injects navigator patches that BotGuard detects.
  const webviewPreload = join(__dirname, '../preload/webview-preload.js')
  webPanelSession.registerPreloadScript({ type: 'frame', filePath: webviewPreload, id: 'webview-preload-wp' })

  // Strawberry-style: strip Electron from UA header on every request (belt-and-suspenders
  // alongside session.setUserAgent). No Sec-CH-UA override — let Chromium send native brands.
  const stripElectronFromHeaders = (details: Electron.OnBeforeSendHeadersListenerDetails, cb: (resp: Electron.BeforeSendResponse) => void) => {
    const uaKey = Object.keys(details.requestHeaders).find(k => k.toLowerCase() === 'user-agent')
    if (uaKey) {
      const ua = details.requestHeaders[uaKey]
      const cleaned = ua.replace(/\s*Electron\/\S+/i, '').replace(/\s*slayzone\/\S+/i, '')
      if (ua !== cleaned) details.requestHeaders[uaKey] = cleaned
    }
    cb({ requestHeaders: details.requestHeaders })
  }
  browserSession.webRequest.onBeforeSendHeaders(stripElectronFromHeaders)
  webPanelSession.webRequest.onBeforeSendHeaders(stripElectronFromHeaders)

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

  const handleBeforeRequest = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void
  ) => {
    // Redirect file:// → slz-file:// so local files load via our secure handler
    if (details.url.startsWith('file://')) {
      callback({ redirectURL: details.url.replace(/^file:\/\//, 'slz-file://') })
      return
    }
    if (shouldCancelLoopbackHandoffRequest(details)) {
      callback({ cancel: true })
      return
    }
    callback({ cancel: false })
  }
  browserSession.webRequest.onBeforeRequest(handleBeforeRequest)
  webPanelSession.webRequest.onBeforeRequest(handleBeforeRequest)

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
    const deniedPermissions = ['geolocation', 'notifications']
    callback(!deniedPermissions.includes(permission))
  })

  // Allow all permission checks (Strawberry-style). Without this, Chromium's default
  // behavior may deny checks that BotGuard relies on to validate the environment.
  browserSession.setPermissionCheckHandler(() => true)

  browserSession.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'hid' || details.deviceType === 'usb') {
      return true
    }
    return false
  })

  // Initialize Chrome Web Store support for service worker lifecycle management.
  const extensionsPath = join(app.getPath('userData'), 'Extensions')
  logBoot('chrome-web-store install start')
  await installChromeWebStore({
    session: browserSession,
    extensionsPath,
    loadExtensions: true,
    allowUnpackedExtensions: true,
  })
  logBoot('chrome-web-store install done')

  // Initialize Chrome extension API support for the browser panel session.
  const chromeExtensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: browserSession,
  })
  ElectronChromeExtensions.handleCRXProtocol(browserSession)
  browserViewManager.setChromeExtensions(chromeExtensions)

  // When an extension popup is created (e.g. 1Password vault), add it to the main window
  chromeExtensions.on('browser-action-popup-created', (popup: { browserWindow: Electron.BrowserWindow }) => {
    if (popup.browserWindow && mainWindow && !mainWindow.isDestroyed()) {
      popup.browserWindow.setParentWindow(mainWindow)
    }
  })

  // Extension persistence — save/restore imported extension paths
  // (installChromeWebStore handles its own extensions, but we also support
  // importing from other browsers via loadExtension)
  const extensionsJsonPath = join(app.getPath('userData'), 'browser-extensions.json')
  const saveExtensionPaths = () => {
    try {
      const exts = browserSession.getAllExtensions().map(e => e.path)
      fsp.writeFile(extensionsJsonPath, JSON.stringify(exts))
    } catch { /* best effort */ }
  }
  const loadSavedExtensions = async () => {
    try {
      const data = await fsp.readFile(extensionsJsonPath, 'utf-8')
      const paths: string[] = JSON.parse(data)
      for (const extPath of paths) {
        try {
          await browserSession.loadExtension(extPath)
        } catch (err) {
          console.warn('[extensions] Failed to reload extension:', extPath, err)
        }
      }
    } catch { /* no saved extensions or file doesn't exist */ }
  }
  void loadSavedExtensions()
  logBoot('extension+session config done')

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


  ipcMain.on('app:data-ready', () => {
    if (rendererDataReady) return
    logBoot('renderer data-ready (IPC from useTasksData)')
    rendererDataReady = true
    tryShowMainWindow()
  })

  // Renderer-emitted boot marks routed into main timeline. Renderer measures
  // are page-relative; we record them with main's clock so the waterfall is
  // unified. Gated behind SLAYZONE_DEBUG_BOOT.
  ipcMain.on('boot:mark', (_event, label: string) => {
    if (typeof label === 'string') logBoot(`renderer: ${label}`)
  })

  ipcMain.handle('app:get-trpc-port', async () => {
    const g = globalThis as Record<string, unknown>
    if (typeof g.__trpcPort === 'number') return g.__trpcPort as number
    return new Promise<number>((resolve) => {
      const start = Date.now()
      const check = (): void => {
        const port = (globalThis as Record<string, unknown>).__trpcPort
        if (typeof port === 'number') resolve(port)
        else if (Date.now() - start > 5000) resolve(0)
        else setTimeout(check, 25)
      }
      check()
    })
  })
  ipcMain.on('app:is-tests-panel-enabled-sync', (event) => { event.returnValue = isLabEnabled('labs_tests_panel') })
  ipcMain.on('app:is-jira-integration-enabled-sync', (event) => { event.returnValue = isLabEnabled('labs_jira_integration') })
  ipcMain.on('app:is-loop-mode-enabled-sync', (event) => { event.returnValue = isLabEnabled('labs_loop_mode') })

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
        properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent'>
        filters?: Array<{ name: string; extensions: string[] }>
      }
    ) => {
      return dialog.showOpenDialog(options)
    }
  )

  // Browser panel registry (CLI browser control — per-tab)
  ipcMain.handle('webview:register-browser-tab', (_, taskId: string, tabId: string, webContentsId: number) => {
    registerBrowserTab(taskId, tabId, webContentsId)
  })
  ipcMain.handle('webview:unregister-browser-tab', (_, taskId: string, tabId: string) => {
    unregisterBrowserTab(taskId, tabId)
  })
  ipcMain.handle('webview:set-active-browser-tab', (_, taskId: string, tabId: string | null) => {
    setActiveBrowserTab(taskId, tabId)
  })

  // Webview shortcut interception
  const registeredWebviews = new Set<number>()
  const keyboardPassthroughWebviews = new Set<number>()

  ipcMain.handle('webview:register-shortcuts', (event, webviewId: number) => {
    if (registeredWebviews.has(webviewId)) return

    const wc = webContents.fromId(webviewId)
    if (!wc) return

    registeredWebviews.add(webviewId)

    wc.on('before-input-event', (e, input) => {
      if (keyboardPassthroughWebviews.has(webviewId)) return
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

    wc.on('destroyed', () => {
      registeredWebviews.delete(webviewId)
      keyboardPassthroughWebviews.delete(webviewId)
    })
  })

  ipcMain.handle('webview:set-keyboard-passthrough', (_event, webviewId: number, enabled: boolean) => {
    if (enabled) keyboardPassthroughWebviews.add(webviewId)
    else keyboardPassthroughWebviews.delete(webviewId)
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

  // Inline DevTools IPC handlers removed — DevTools now docked natively via browser-view-manager

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

  // --- Browser View Manager (WebContentsView) ---
  // Wire handoff policy mirror so main-process hardening listeners see WCV policies
  browserViewManager.setHandoffPolicyChangeCallback((wcId, policy) => {
    if (policy) {
      webviewDesktopHandoffPolicy.set(wcId, policy)
    } else {
      webviewDesktopHandoffPolicy.delete(wcId)
    }
  })

  ipcMain.on('browser:request-create-task-from-link', (event, payload: { url?: unknown; linkText?: unknown }) => {
    const url = typeof payload?.url === 'string' ? payload.url : ''
    if (!/^https?:\/\//i.test(url)) return
    const linkText = typeof payload?.linkText === 'string' ? payload.linkText : undefined
    browserViewManager.emitCreateTaskFromLinkForWebContents(event.sender.id, { url, linkText, source: 'modified-link-click' })
  })
  ipcMain.on('browser:request-open-link-externally', (_event, payload: { url?: unknown }) => {
    const url = typeof payload?.url === 'string' ? payload.url : ''
    if (!/^https?:\/\//i.test(url)) return
    void shell.openExternal(url)
  })


  // Test-only handles
  if (isPlaywright) {
    ipcMain.handle(
      'browser:test-dispatch-mouse-click',
      (_event, viewId: string, point: { x?: unknown; y?: unknown }, modifiers?: unknown) => {
        const x = typeof point?.x === 'number' ? point.x : NaN
        const y = typeof point?.y === 'number' ? point.y : NaN
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false

        const normalizedModifiers = Array.isArray(modifiers)
          ? modifiers.filter((modifier): modifier is 'shift' | 'control' | 'alt' | 'meta' =>
            modifier === 'shift' || modifier === 'control' || modifier === 'alt' || modifier === 'meta')
          : []

        return browserViewManager.dispatchMouseClick(viewId, { x, y }, normalizedModifiers)
      }
    )
    ipcMain.handle('browser:test-dispatch-create-task-from-link', (_event, viewId: string, payload: { url?: unknown; linkText?: unknown }) => {
      const url = typeof payload?.url === 'string' ? payload.url : ''
      if (!/^https?:\/\//i.test(url)) return false
      const linkText = typeof payload?.linkText === 'string' ? payload.linkText : undefined
      return browserViewManager.emitCreateTaskFromLinkForView(viewId, { url, linkText, source: 'modified-link-click' })
    })
    ipcMain.handle(
      'browser:test-run-link-context-menu-action',
      (_event, viewId: string, payload: { linkURL?: unknown; linkText?: unknown }, action: unknown) => {
        const linkURL = typeof payload?.linkURL === 'string' ? payload.linkURL : ''
        const linkText = typeof payload?.linkText === 'string' ? payload.linkText : ''
        if (
          action !== 'create-task-from-link' &&
          action !== 'open-link-in-new-tab' &&
          action !== 'copy-link' &&
          action !== 'open-link-externally'
        ) {
          return false
        }
        return browserViewManager.runLinkContextMenuAction(viewId, { linkURL, linkText }, action)
      }
    )
  }

  initProcessManager(db)
  logBoot('process manager initialized')

  // Reset all main-process state + DB for test isolation (Playwright only)
  if (isPlaywright) {
    ipcMain.handle('app:reset-for-test', async () => {
      // 1. Kill running processes
      killAllPtys()
      shutdownChatTransports()
      stopIdleChecker()
      killAllProcesses()

      // 2. Stop timers
      stopAutoBackup()
      if (linearSyncPoller) { clearInterval(linearSyncPoller); linearSyncPoller = null }
      if (discoveryPoller) { clearInterval(discoveryPoller); discoveryPoller = null }

      // 3. Stop MCP + tRPC servers (restarted after table drop so ports persist)
      mcpCleanup?.()
      mcpCleanup = null
      ;(globalThis as Record<string, unknown>).__mcpPort = undefined
      trpcCleanup?.()
      trpcCleanup = null
      ;(globalThis as Record<string, unknown>).__trpcPort = undefined

      // 4. Close file watchers
      closeAllFileWatchers()
      closeArtifactWatcher()
      closeGitWatcher()

      // 5. Clear registries + flags + browser view manager
      clearBrowserRegistry()
      resetSyncFlags()
      browserViewManager.reset()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.zoomLevel = 0
        mainWindow.webContents.send('app:zoom-factor-changed', mainWindow.webContents.zoomFactor)
      }

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

      // 8. Restart MCP + tRPC (after table drop so ports persist to fresh settings table)
      const mcpMod = await import('./mcp-server')
      mcpMod.startMcpServer(db, { automationEngine })
      mcpCleanup = () => mcpMod.stopMcpServer()
      const trpcMod = await import('@slayzone/transport/server')
      trpcMod.startTrpcServer({ db, dataRoot: getDataRoot(), automationEngine })
      trpcCleanup = () => trpcMod.stopTrpcServer()
      // Wait for both servers to be listening
      await new Promise<void>((resolve) => {
        const check = () => {
          const g = globalThis as Record<string, unknown>
          if (g.__mcpPort && g.__trpcPort) resolve()
          else setTimeout(check, 10)
        }
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

  recordDiagnosticEvent({
    level: 'info', source: 'main', event: 'app.boot.ready',
    payload: { version: app.getVersion() }
  })

  // PTY stats poller — lazy start/stop via session lifecycle
  const ptyStatsPoller = createStatsPoller(
    () => getPtyPids(),
    (stats) => { mainWindow?.webContents.send('pty:stats', stats) }
  )
  onSessionChange(() => ptyStatsPoller.ensureStarted())

  // Wire processes ops + events into tRPC router
  setProcessesDeps({
    create: createProcess,
    spawn: spawnProcess,
    update: updateProcess,
    stop: stopProcess,
    kill: killProcess,
    restart: restartProcess,
    listForTask,
    listAll: listAllProcesses,
    killTask: killTaskProcesses,
    events: processEvents,
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
  // Handoff blocking helpers — check policy map at invocation time (lazy guard).
  // Works for both legacy <webview> and WCV-managed views because both populate
  // webviewDesktopHandoffPolicy via their respective paths.
  const isLoopbackHandoffUrl = (url: string): boolean => {
    const desktopHandoffPolicy = webviewDesktopHandoffPolicy.get(wc.id)
    if (!desktopHandoffPolicy) return false
    if (!isLoopbackUrl(url)) return false
    const hostScope = normalizeDesktopHostScope(desktopHandoffPolicy.hostScope)
    if (isLoopbackHost(hostScope)) return false
    return true
  }

  const shouldBlockDesktopHandoffUrl = (url: string): boolean => {
    if (isLoopbackHandoffUrl(url)) return true
    const desktopHandoffPolicy = webviewDesktopHandoffPolicy.get(wc.id)
    if (!desktopHandoffPolicy) return false
    return isEncodedDesktopHandoffUrl(url, desktopHandoffPolicy)
  }

  const isWebviewOrHasPolicy = () => wc.getType() === 'webview' || webviewDesktopHandoffPolicy.has(wc.id)

  // Handoff hardening: legacy webviews + WCV views with policies.
  // setWindowOpenHandler for legacy webviews only — WCV views get their handler from the manager.
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler((details) => {
      if (webviewDesktopHandoffPolicy.has(wc.id)) return { action: 'deny' }
      if (details.disposition === 'new-window' && /^https?:\/\//i.test(details.url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
          },
        }
      }
      return { action: 'deny' }
    })
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
  }

  // Frame navigation guard + handoff hardening — applies to both webview and WCV with policy.
  // Listeners check policy lazily at invocation time, so policy can be set after creation.
  wc.on('will-frame-navigate', (event) => {
    if (!isWebviewOrHasPolicy()) return
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
      spoofingReady = false
    } finally {
      spoofingPending = false
    }
  }

  const maybeApplyDesktopHandoffHardening = () => {
    const desktopHandoffPolicy = webviewDesktopHandoffPolicy.get(wc.id)
    if (!desktopHandoffPolicy) return
    void ensureDesktopHandoffSpoofing()
    wc.mainFrame?.executeJavaScript(WEBVIEW_INIT_SCRIPT).catch(() => {})
  }

  wc.on('did-start-navigation', (_event, _navigationUrl, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    if (!isWebviewOrHasPolicy()) return
    maybeApplyDesktopHandoffHardening()
  })
  wc.on('did-navigate', () => {
    if (!isWebviewOrHasPolicy()) return
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
  trpcCleanup?.()
  // Record completion BEFORE closing diagnostics DB; a row written here is the last
  // event of the session and proves the chain ran. stopDiagnostics() can clear timers
  // safely after.
  recordDiagnosticEvent({
    level: 'info', source: 'main', event: 'app.will-quit.complete',
    payload: { version: app.getVersion() }
  })
  stopDiagnostics()
  stopIdleChecker()
  stopAutoBackup()
  closeArtifactWatcher()
  closeGitWatcher()
  killAllPtys()
  shutdownChatTransports()
  killAllProcesses()
  closeDatabase()
  closeDiagnosticsDatabase()
  // Sentinel last: presence on next boot ⇒ clean shutdown reached this line.
  // Pure fs (no DB needed), so survives any prior close failure.
  writeCleanShutdownSentinel()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
