// Raise RLIMIT_NOFILE before anything else can spawn a child so every
// descendant (PTYs, ripgrep, git, renderer helpers) inherits a high soft
// limit. Best-effort: logs and continues on failure — the per-PTY sh wrapper
// in shell-env.ts still protects terminal sessions if the native addon
// can't load.
import { raiseFdLimit } from './raise-fd-limit'
const fdLimitResult = raiseFdLimit()
console.log('[fd-limit]', JSON.stringify(fdLimitResult))

import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  session,
  webContents,
  dialog,
  Menu,
  protocol,
  screen,
  powerMonitor,
  crashReporter
} from 'electron'
import { join, extname, normalize, sep, resolve } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, promises as fsp, mkdirSync, appendFileSync } from 'fs'
import { electronApp, is } from '@electron-toolkit/utils'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore } from 'electron-chrome-web-store'
import {
  registerBrowserTab,
  unregisterBrowserTab,
  setActiveBrowserTab,
  clearBrowserRegistry,
  getResolvedBrowserTabId,
  listBrowserTabs,
  hasBrowserTab,
  awaitBrowserRegistration,
  browserExecJs,
  browserLoadUrl,
  browserGetUrl,
  browserCapturePageToFile
} from './browser-registry'
import {
  BrowserViewManager,
  browserViewEvents,
  type CreateViewOpts,
  type ViewBounds
} from './browser-view-manager'
import { attachRendererCsp } from './renderer-csp'
import {
  probeRemoteHealth,
  hubLogin,
  readBootConfig,
  writeBootSettings,
  resolveHubRegistry,
  resolveDefaultHubId,
  LOCAL_HUB_ID
} from './boot-config'
import type { HubEntry } from '@slayzone/types'
import { installHubCertPinning, setPinnedHubs } from './hub-cert-pinning'
import { setHubTokenCipher, setHubToken, getAllHubTokens } from './hub-tokens'
import {
  BLOCKED_EXTERNAL_PROTOCOLS,
  isBlockedExternalProtocolUrl,
  isEncodedDesktopHandoffUrl,
  isLoopbackHost,
  isLoopbackUrl,
  isUrlWithinHostScope,
  normalizeDesktopHostScope,
  normalizeDesktopProtocol,
  type DesktopHandoffPolicy
} from '@slayzone/task/shared'
import {
  toElectronAccelerator,
  matchesElectronInput,
  shortcutDefinitions,
  MENU_SHORTCUT_DEFAULTS,
  type ElectronInput
} from '@slayzone/shortcuts'

// Mutable shortcut overrides — updated from DB when shortcuts change.
// Module-scope so both createMainWindow (before-input-event) and app.whenReady (menu) can access.
let currentOverrides: Record<string, string | null> = {}

/** Resolve effective keys for a shortcut ID, checking overrides then defaults. */
function getEffectiveKeys(id: string, overrides: Record<string, string | null>): string | null {
  if (id in overrides) return overrides[id]
  const def = shortcutDefinitions.find((d) => d.id === id)
  return def?.defaultKeys ?? null
}

/**
 * Resolves the in-process tRPC WS port once the server is listening, or 0
 * after `timeoutMs`. The port is published on `globalThis.__trpcPort` by
 * startTrpcServer; it lands shortly after boot since the server starts off
 * the critical path. Consumed by the `app:get-trpc-port` IPC and the renderer
 * CSP header builder.
 */
function awaitTrpcPort(timeoutMs = 5000): Promise<number> {
  const existing = (globalThis as Record<string, unknown>).__trpcPort
  if (typeof existing === 'number') return Promise.resolve(existing)
  return new Promise<number>((resolve) => {
    const start = Date.now()
    const check = (): void => {
      const port = (globalThis as Record<string, unknown>).__trpcPort
      if (typeof port === 'number') resolve(port)
      else if (Date.now() - start > timeoutMs) resolve(0)
      else setTimeout(check, 25)
    }
    check()
  })
}

// Custom protocol for serving local files in browser panel webviews
// (must be registered before app ready — Chromium blocks file:// in webviews)
// External app protocols registered here so Chromium routes them through our session handler
// instead of passing them to the OS (which would launch desktop apps like Figma, Slack, etc.)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'slz-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  ...BLOCKED_EXTERNAL_PROTOCOLS.map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true }
  }))
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

// Raise renderer V8 heap. React 19 dev-mode `logComponentRender` calls
// performance.measure(name, { detail: fiber }) — with big in-memory state
// (1000+ tasks, many open tabs) the structured-clone of detail OOMs the
// renderer, which then crashes and triggers a full reload via the
// render-process-gone handler. 8 GB buys headroom until hidden tabs unmount.
if (is.dev) {
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192')
}

// GPU compositor flags — smoother raster on M-series Macs.
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization')

// Linux XDG Base Directory compliance: move state data from ~/.config to ~/.local/state
import {
  migrateXdgIfNeeded,
  migrateCliBinIfNeeded,
  getStateDir,
  installCli,
  checkCliInstalled,
  getCliBinTarget,
  getManualInstallHint,
  getSupervisedRoot,
  SIDECAR_FIXED_PORT,
  SLZ_FILE_HOST,
  fileUrlToSlzFileUrl
} from '@slayzone/platform'
import { initStorageDir, getStorageDir } from './data-paths'
if (process.platform === 'linux') {
  const result = migrateXdgIfNeeded()
  if (!result.failed) {
    // Redirect userData on Linux — fresh install, post-migration, or already migrated.
    // Skip only if migration failed (old dir exists but copy failed) — fall back to Electron default.
    const stateDir = getStateDir()
    mkdirSync(stateDir, { recursive: true })
    app.setPath('userData', stateDir)
  }
}

// The legacy state location = userData BEFORE any dev/e2e profile swap below.
// This is the migration source (our DB/artifacts historically lived here).
const legacyStateDir = app.getPath('userData')

if (isPlaywright && process.env.SLAYZONE_USER_DATA_DIR) {
  // Playwright runs alongside the user's dev app, so isolate the entire
  // Electron profile instead of only redirecting the SQLite DB path.
  mkdirSync(process.env.SLAYZONE_USER_DATA_DIR, { recursive: true })
  app.setPath('userData', process.env.SLAYZONE_USER_DATA_DIR)
} else if (is.dev) {
  // Dev runs alongside the packaged app. Two Chromium instances sharing one
  // profile corrupts partition storage (wedged IndexedDB/quota service,
  // "Database IO error" on service worker DB), so isolate dev's Electron
  // profile the same way Playwright does above. Only the Chromium profile
  // (Partitions, storage, caches) moves; our DB/artifacts are anchored to this
  // app's channel-scoped hub root below.
  const devProfileDir = `${legacyStateDir}-dev`
  mkdirSync(devProfileDir, { recursive: true })
  app.setPath('userData', devProfileDir)
}

// Release channel → env. Must run BEFORE initStorageDir below: getSupervisedRoot()
// (which resolves this app's own storage root) reads it via
// getSlayzoneReleaseChannel() to pick the dev-vs-stable bucket, so deriving it
// later would anchor every boot to `stable` regardless of build.
//
// Also read later, BEFORE the sidecar/pty env is built: `buildMcpEnv` (in the
// electron-free terminal domain) packs it into the opaque
// SLAYZONE_AGENT_HOOK_CONTEXT blob, so the server logs which release channel a
// hook came from. The shared ~/.slayzone/hooks/notify.sh is NOT
// release-channel-scoped (prod + dev share one file); recording the release
// channel makes a future cross-release-channel clobber visible in Diagnostics
// instead of silent.
// Derivation: dev (unpackaged) vs beta (prerelease tag) vs stable. Note the
// storage bucket folds beta into stable — see getSupervisedRoot's doc comment.
if (!process.env.SLAYZONE_RELEASE_CHANNEL) {
  process.env.SLAYZONE_RELEASE_CHANNEL = !app.isPackaged
    ? 'dev'
    : app.getVersion().includes('-')
      ? 'beta'
      : 'stable'
}

// Anchor all our state (DB, artifacts, recent backups, logs) under this app's
// CHANNEL-SCOPED HUB ROOT — ~/.slayzone/<dev|stable>/hub — running the two
// one-time COPY migrations that feed it: out of the legacy flat ~/.slayzone
// layout, and out of the legacy Electron userData dir (Electron keeps its own
// profile there). Uses the pre-swap userData as the second migration's SOURCE so
// the dev profile-swap above doesn't hide the legacy data.
//
// This app IS the hub role. The sidecar it spawns is handed the SAME root
// explicitly (SLAYZONE_ROOT below) rather than inheriting an ambient one, and
// the co-located local runner is handed its own separate `runner` root — that
// explicit per-child handoff is what actually keeps the two roles' state apart.
// The main process's OWN ambient SLAYZONE_ROOT stays untouched, so the hook
// installers later in this boot keep writing to the unscoped ~/.slayzone/hooks.
initStorageDir(legacyStateDir, app.isPackaged)

// tRPC server data root = the resolved storage dir, so every router's ctx.dataRoot
// resolves project-icons/artifacts to the same dir the renderer reads.
/**
 * Where CLIENT state lives — `~/.slayzone/<channel>/client`.
 *
 * It used to be `getStorageDir()`, i.e. the HUB role's root. That put
 * `boot-config.json` — the file that decides whether a local hub runs at all —
 * and `hub-tokens.json` (safeStorage bearer tokens) inside the directory owned by
 * the thing they configure. In remote mode that directory existed for no other
 * reason, and any future "reset the local hub" would take the user's remote-hub
 * registry and credentials with it.
 */
function getClientStateRoot(): string {
  return getClientRoot()
}

/** The old location, used ONLY as a read-only fallback until each file is rewritten. */
function getLegacyClientStateRoot(): string {
  return getStorageDir()
}

import icon from '../../resources/icon.png?asset'
import logoSolid from '../../resources/logo-solid.svg?asset'
import {
  initDatabases,
  closeDiagnosticsDatabase,
  getDatabasePath
} from './db'
import { migrateV127DiskDir } from './db/v127-disk-migration'
import { startProactiveGc } from './proactive-gc'
import {
  filesPathExists,
  filesSaveTempImage,
  buildPdfHtml,
  buildMermaidPdfHtml,
  buildPngHtml,
  renderToPdf,
  renderToPng
} from '@slayzone/task/electron'
import {
  configureTaskRuntimeAdapters,
  closeArtifactWatcher,
  taskOps
} from '@slayzone/task/server'
import { wireNativeThemeBridge } from '@slayzone/settings/electron'
import {
  getEffectiveTheme as nativeGetEffectiveTheme,
  getThemeSource as nativeGetThemeSource,
  setTheme as nativeSetTheme
} from '@slayzone/settings/theme'
import { getClientRoot } from '@slayzone/platform'
import { readClientSettings, updateClientSettings } from '@slayzone/platform/client-settings'
import { migrateClientSettings } from './client-settings-migration'

/**
 * One-shot latch for the Linux CLI-symlink warning. Client-scoped by nature —
 * it records whether THIS machine has been warned about a stale
 * `/usr/local/bin` symlink, which is not a fact about anyone's account.
 */
/**
 * E2E-only bridge to the side-car's dev routes. The host has no database, so the
 * things e2e used to do directly against `db` are asked of the process that does.
 * Gated the same way on both ends (`PLAYWRIGHT=1`).
 */
async function devPost(path: string, body?: unknown): Promise<unknown> {
  const port = (globalThis as Record<string, unknown>).__serverPort as number | undefined
  if (!port) throw new Error('dev route: side-car port not resolved yet')
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  const json = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!json.ok) throw new Error(json.error ?? `dev route ${path} failed`)
  return json.result
}

const devSql = (method: string, sql: string, params?: unknown[]): Promise<unknown> =>
  devPost('/api/dev/sql', { method, sql, params })
const devSqlRun = (sql: string, params?: unknown[]): Promise<unknown> => devSql('run', sql, params)
const devReset = (): Promise<unknown> => devPost('/api/dev/reset')

async function markCliMigrationDialogShownLocally(): Promise<boolean> {
  const root = getClientRoot()
  if (readClientSettings(root).cli?.migrationDialogShown) return false
  await updateClientSettings({ cli: { migrationDialogShown: true } }, root)
  return true
}
import {
  wireWarmWindowCleanup,
  killAllPtys,
  shutdownAllPtys,
  killPtysByTaskId,
  onTaskReachedTerminal,
  startIdleChecker,
  stopIdleChecker,
  getPtyPids,
  onSessionChange,
  buildUsageOps,
  shutdownChatTransports,
  killAllChatTransports,
  broadcastRespawnRequest,
  setReinstallHooks,
  beginTerminalShutdown,
  teardownAllWarm,
  ptyEvents
} from '@slayzone/terminal/electron'
import { setOnTaskReachedTerminalHandler } from '@slayzone/terminal/server'
import {
  attachFloatingGlobalAgentPanel,
  setupFloatingGlobalAgentPanel,
  floatingGlobalAgentPanelOps,
  floatingGlobalAgentPanelEvents
} from './floating-global-agent-panel'
import {
  attachTaskWindows,
  setupTaskWindows,
  taskWindowsOps,
  taskWindowsEvents
} from './task-windows'
import { closeGitWatcher } from '@slayzone/worktrees/server'
import { DEFAULT_LOCAL_RUNNER_NAME } from '@slayzone/runners/shared'
import {
  registerDiagnosticsHandlers,
  registerProcessDiagnostics,
  stopDiagnostics,
  setIpcSuccessHook
} from '@slayzone/diagnostics/electron'
import { recordDiagnosticEvent, saveDiagnosticsConfig } from '@slayzone/diagnostics/server'
import {
  detectPreviousCrash,
  writeBootStub,
  writeCleanShutdownSentinel,
  scanCrashDumps
} from './lifecycle/sentinel'
import {
  acquireLockWithSelfHeal,
  lockOutcomeIsAcquired,
  type LockOutcome
} from './lifecycle/single-instance'
import { IPC_TELEMETRY_MAP } from '@slayzone/telemetry/shared'
import { getSafeStorageCipher } from '@slayzone/integrations/electron'
import {
  resetSyncFlags,
  setCredentialCipher,
} from '@slayzone/integrations/server'
import { closeAllWatchers } from '@slayzone/file-editor/electron'
import { captureBrowserViewScreenshot } from './screenshot'
import {
  writeFilePaths,
  readFilePaths,
  hasFilePaths
} from './clipboard-handlers'
import {
  setProcessManagerWindow,
  createProcess,
  spawnProcess,
  updateProcess,
  stopProcess,
  killProcess,
  restartProcess,
  listForTask,
  listAllProcesses,
  killTaskProcesses,
  killAllProcesses,
  shutdownAllProcesses,
  processEvents,
  createStatsPoller
} from '@slayzone/processes/server'
import { notifyEvents } from './notify-renderer'
import { presentWindow } from './present-window'
import { menuEvents } from './menu-events'
import { automationsEvents } from './automations-events'
import { telemetryEvents } from './telemetry-events'
import { agentLifecycleEvents } from './agent-lifecycle-events'
import { powerResumeEvents } from './power-resume-events'
import { startDesktopBridgeServer } from './desktop-bridge-server'
import { shellOpenExternal, shellOpenPath } from './shell-open'
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
let bridgeCleanup: (() => void) | null = null
let sidecarCleanup: (() => void) | null = null
let sidecarServerHandle: import('./sidecar-server-supervisor').SidecarServerHandle | null = null
// Local-runner supervisor — spawns the co-located runner in local mode. Null
// in remote mode (no local hub to dial) or before the async spawn runs.
let localRunnerCleanup: (() => void) | null = null
// The same supervisor's handle. Kept separately from the cleanup thunk because
// `app:restart-local-runner` needs to CYCLE it, not just stop it at quit.
let localRunnerHandle: import('./local-runner-supervisor').LocalRunnerHandle | null = null
// Local cutover (slice 9): the side-car must be spawned with the desktop bridge
// address in env, but that server starts on its own async path. This promise
// lets the sidecar-spawn block await the bound port. One listener now carries
// both the capability bridge (WS `/cap`) and the reverse-proxied Electron-only
// REST (`/api/*`), advertised as `SLAYZONE_DESKTOP_BRIDGE_ADDRESS`.
let resolveDesktopBridgeAddress!: (address: string) => void
const desktopBridgeAddressPromise = new Promise<string>((r) => {
  resolveDesktopBridgeAddress = r
})
// Resolves once the side-car supervisor handle exists, so `app:get-server-url`
// (called early on renderer boot) can await it before reading the port.
let resolveSidecarHandle!: (
  h: import('./sidecar-server-supervisor').SidecarServerHandle
) => void
const sidecarHandlePromise = new Promise<
  import('./sidecar-server-supervisor').SidecarServerHandle
>((r) => {
  resolveSidecarHandle = r
})

// Shared by the `app:get-sidecar-status` / `app:reveal-sidecar-log` IPC
// handlers and the tRPC `app.meta.*` procs (one impl, both transports).
function getSidecarStatusSnapshot(): import('./sidecar-server-supervisor').SidecarStatus {
  return (
    sidecarServerHandle?.getStatus() ?? {
      health: 'starting' as const,
      port: null,
      pid: null,
      restarts: 0,
      totalRespawns: 0,
      dbPath: null,
      uptimeMs: null,
      runningBuildId: null,
      diskBuildId: null,
      stale: false
    }
  )
}

function revealSidecarLogInFinder(): void {
  // The sidecar writes logs under the storage dir it was handed (getStorageDir()).
  shell.showItemInFolder(join(getStorageDir(), 'logs', 'sidecar.log'))
}

/**
 * Mint a runner join token over LOOPBACK REST against the sidecar (hub/runner
 * split, Wave3.5-D3). Retries while the runner listener is still binding — the
 * sidecar reports "ready" (health) as soon as its shared http server listens,
 * but the SEPARATE /runners wss listener binds a beat later + only THEN feeds its
 * url/fingerprint to the runners registry (server.ts), so `/api/runners/join-token`
 * 503s until then. Returns the token + wss url, or null once the budget is spent.
 */
async function mintLocalRunnerJoinToken(
  sidecarPort: number
): Promise<{ token: string; hubUrl: string } | null> {
  const url = `http://127.0.0.1:${sidecarPort}/api/runners/join-token`
  const MAX_ATTEMPTS = 40
  const RETRY_DELAY_MS = 1000
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: DEFAULT_LOCAL_RUNNER_NAME
        })
      })
      if (res.ok) {
        const body = (await res.json()) as { token?: unknown; hubUrl?: unknown }
        if (typeof body.token === 'string' && typeof body.hubUrl === 'string') {
          return { token: body.token, hubUrl: body.hubUrl }
        }
        logBoot('[local-runner] mint response malformed — giving up')
        return null
      }
      // 503 = runner listener not bound yet → keep retrying. Any other status is a
      // hard error (misconfig / runner off despite the gate) → stop.
      if (res.status !== 503) {
        logBoot(`[local-runner] mint failed status=${res.status} — not retrying`)
        return null
      }
    } catch {
      // Connection refused / sidecar mid-restart → retry.
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
  }
  logBoot(`[local-runner] mint timed out after ${MAX_ATTEMPTS} attempts`)
  return null
}

/**
 * Boot-time local-runner auto-enroll (Wave3.5-D3). Waits for the sidecar to be
 * ready, mints a join token over loopback REST, then spawns the co-located
 * runner with the token + wss hub url injected → it dials + enrolls with ZERO
 * manual config. Called in local mode (see the boot block); a mint failure
 * leaves the runner unspawned (log-only, never crashes boot).
 */
async function startLocalRunnerWithAutoEnroll(): Promise<void> {
  logBoot('local-runner auto-enroll: awaiting sidecar ready')
  const handle = await sidecarHandlePromise
  await handle.waitForReady()
  const sidecarPort = handle.getPort()
  if (!sidecarPort) {
    logBoot('[local-runner] sidecar has no port after ready — skipping auto-enroll')
    return
  }

  const minted = await mintLocalRunnerJoinToken(sidecarPort)
  if (!minted) {
    // Do NOT spawn a token-less runner (it would only backoff-loop). The user can
    // still enroll a remote runner via the UI.
    //
    // This used to be log-only, which was survivable while the hub could spawn
    // agents in-process. It no longer can — runners run the agents — so an
    // unspawned local runner means NO agents can start at all. Record it as a
    // diagnostic error so it shows up in the Diagnostics tab instead of only in a
    // boot log nobody reads.
    logBoot('[local-runner] no join token minted — leaving runner unspawned')
    try {
      recordDiagnosticEvent({
        level: 'error',
        source: 'main',
        event: 'local_runner.unspawned',
        message:
          'Local runner could not be enrolled (join-token mint failed). Agents, terminals and ' +
          'git work all run on runners — enroll one in Settings → Runners, or restart the app.'
      })
    } catch {
      /* diagnostics unavailable this early — the boot log above still records it */
    }
    return
  }

  // The mint window (waitForReady + retries) can straddle an app quit: the quit
  // drain already ran localRunnerCleanup (while it was still null), so spawning
  // now would orphan a child no cleanup hook tracks. Skip if quit has drained.
  if (quitDrainComplete) {
    logBoot('[local-runner] app quitting — skipping runner spawn')
    return
  }

  const { startLocalRunner } = await import('./local-runner-supervisor')
  const runnerScriptPath = is.dev
    ? join(app.getAppPath(), '../runner/dist/bin.cjs')
    : join(process.resourcesPath, 'runner', 'bin.cjs')
  // The local runner gets its OWN channel-scoped root, handed over explicitly
  // below — it no longer shares one ambient root with the hub (which is how a
  // runner-owned credential store ended up loose inside the hub's state). Its FS
  // path-jail still self-derives: under SLAYZONE_SUPERVISED=1 loadRunnerConfig
  // defaults allowedRoots to `[homedir()]` (local runner operates on the user's
  // own projects), so there is no env handoff for that.
  const handleRunner = startLocalRunner({
    execPath: process.execPath,
    scriptPath: runnerScriptPath,
    env: {
      ...process.env,
      // This runner's own channel-scoped RUNNER root — separate from the hub's,
      // so its credential store (runner.state.json) and logs never mix with the
      // hub's DB/artifacts. Explicit because the runner cannot derive it:
      // getSupervisedRoot is desktop-app-only, and an inherited-unset value would
      // land it back on the flat, channel-shared ~/.slayzone. OVERRIDES anything
      // inherited (in dev the repo may set it) so the local runner always uses
      // this boot's channel root.
      SLAYZONE_ROOT: getSupervisedRoot('runner'),
      // This local runner is HOST-SUPERVISED: the Electron app spawns + manages it
      // and supplies its env in full below. Flag it so the runner does NOT cwd-seed
      // SLAYZONE_ROOT (bin.ts) — without this it treated the app's CWD (the repo in
      // dev) as its root. Belt-and-braces now that SLAYZONE_ROOT is set explicitly
      // above (the seed only fires when unset), but the flag still drives the
      // supervised defaults for enroll name + path-jail.
      SLAYZONE_SUPERVISED: '1',
      // Auto-enroll: the freshly minted token embeds the cert fingerprint the
      // runner pins. The env channel carries the hub AUTHORITY only
      // (host[:port]) — the runner re-derives ws(s):// from SLAYZONE_MODE and
      // appends /runners (see runner config.ts). Extract the authority from the
      // mint's full ws(s)://host[:port]/runners url. OVERRIDES any inherited
      // value so the local runner always dials THIS boot's hub.
      SLAYZONE_HUB_ADDRESS: new URL(minted.hubUrl).host,
      // No SLAYZONE_RUNNER_NAME / SLAYZONE_RUNNER_ALLOWED_ROOTS handoff: under
      // SLAYZONE_SUPERVISED=1 (above) the runner defaults its enroll name to
      // DEFAULT_LOCAL_RUNNER_NAME (matching the hub's localRunnerName so the dedup
      // collapses to one row) and its path-jail to `[homedir()]`.
      SLAYZONE_HUB_JOIN_TOKEN: minted.token
    },
    logger: (line) => logBoot(line),
    // Every agent pty is a direct child of the runner, so a runner exit kills
    // every agent on the machine at once and the hub renders it as "Process
    // exited with code 1" on every open task (exec-proxies disposes each session
    // on runner-disconnected). That was previously untraceable: `logger` above
    // feeds logBoot, a no-op unless SLAYZONE_DEBUG_BOOT=1, so neither the exit
    // code nor the runner's dying output reached anywhere durable. Record it.
    onExit: (info) => {
      try {
        recordDiagnosticEvent({
          // A restart-pending exit is recoverable; a terminal one is not.
          level: info.restartAttempt === null ? 'error' : 'warn',
          source: 'main',
          event: 'local_runner.exit',
          message:
            `Local runner exited (code=${String(info.code)} signal=${String(info.signal)}) after ` +
            `${Math.round(info.uptimeMs / 1000)}s — every agent terminal on this machine died with it. ` +
            (info.restartAttempt === null
              ? 'No restart left in the backoff budget.'
              : `Restarting in ${String(info.restartDelayMs)}ms (attempt ${info.restartAttempt}).`),
          payload: {
            code: info.code,
            signal: info.signal,
            uptimeMs: info.uptimeMs,
            restartAttempt: info.restartAttempt,
            restartDelayMs: info.restartDelayMs,
            // The dying runner's own output — the only place an uncaught
            // exception stack or a fatal dialer error is visible.
            tail: info.tail
          }
        })
      } catch {
        /* diagnostics unavailable — never let reporting break supervision */
      }
    },
    // Re-mint before each restart. The token above is SINGLE-USE, so a runner that
    // exits fatally on "join token rejected: unknown" (its stored api key failed
    // verification, and its re-enroll fallback then reused a spent token) would
    // otherwise fail identically on every retry and stay dead until the app
    // restarts. Now every retry gets a usable token.
    mintJoinToken: async () => {
      const port = sidecarServerHandle?.getPort()
      if (!port) return null
      const fresh = await mintLocalRunnerJoinToken(port)
      return fresh?.token ?? null
    },
    onNeedsReEnrollment: () => {
      // The hub no longer recognizes this runner, so restarting cannot help. Say so
      // where the user will see it: nothing can execute until it is enrolled again.
      console.error('[local-runner] needs re-enrollment — the hub does not recognize this runner')
      try {
        recordDiagnosticEvent({
          level: 'error',
          source: 'main',
          event: 'local_runner.needs_re_enrollment',
          message:
            'The local runner must be enrolled again — the hub no longer recognizes it ' +
            '(its stored credentials were refused). Agents, terminals and git work all run ' +
            'on runners, so nothing can execute until it is re-enrolled from Settings → Runners.'
        })
      } catch {
        /* diagnostics unavailable — the console error above still records it */
      }
    },
    onPermanentFailure: (info) => {
      console.error('[local-runner] permanent failure (local runner, non-fatal):', info)
      // After this point NOTHING can execute — runners run the agents. Surface it
      // where the user can see it rather than only in a console nobody reads.
      try {
        recordDiagnosticEvent({
          level: 'error',
          source: 'main',
          event: 'local_runner.permanent_failure',
          message:
            `Local runner failed to stay running after ${(info as { attempts?: number }).attempts ?? 0} attempts. ` +
            'Agents, terminals and git work all run on runners — restart the app or enroll a runner manually.'
        })
      } catch {
        /* diagnostics unavailable — the console error above still records it */
      }
    }
  })
  localRunnerHandle = handleRunner
  localRunnerCleanup = () => void handleRunner.stop()
  logBoot('local-runner supervisor started (auto-enrolled)')
}

/**
 * Single-flight wrapper around {@link startLocalRunnerWithAutoEnroll}.
 *
 * Load-bearing for the Settings → Runners "Start" action: the boot attempt polls
 * for a mintable join token for up to ~40s (`mintLocalRunnerJoinToken`), so a
 * user who clicks Start while that is still running would otherwise spawn a
 * SECOND supervisor — two runners enrolling under the same name, only one of
 * which any cleanup hook tracks.
 */
let localRunnerStartInFlight: Promise<void> | null = null
function ensureLocalRunnerStarted(): Promise<void> {
  if (localRunnerStartInFlight) return localRunnerStartInFlight
  localRunnerStartInFlight = startLocalRunnerWithAutoEnroll().finally(() => {
    localRunnerStartInFlight = null
  })
  return localRunnerStartInFlight
}
let quitDrainComplete = false
let quitSubprocessCleanupPromise: Promise<void> | null = null
const QUIT_SUBPROCESS_TERM_GRACE_MS = 1500
const QUIT_SUBPROCESS_HARD_TIMEOUT_MS = 5000
type OAuthCallbackPayload = { code?: string; error?: string }
const oauthCallbackQueue: OAuthCallbackPayload[] = []
const oauthCallbackWaiters = new Set<(payload: OAuthCallbackPayload) => void>()
let mainWindowReady = false
let rendererDataReady = false
let rendererReloading = false
const APP_PROTOCOL_SCHEME = 'slayzone'
// Avoid stealing the global slayzone:// handler from packaged builds during local dev.
const SHOULD_REGISTER_PROTOCOL_CLIENT =
  !is.dev || process.env.SLAYZONE_REGISTER_DEV_PROTOCOL === '1'
type ProtocolClientStatusReason = 'registered' | 'dev-skipped' | 'registration-failed'
type ProtocolClientStatus = {
  scheme: string
  attempted: boolean
  registered: boolean
  reason: ProtocolClientStatusReason
}

function shutdownSubprocessesForQuit(): Promise<void> {
  if (quitSubprocessCleanupPromise) return quitSubprocessCleanupPromise
  const opts = {
    termGraceMs: QUIT_SUBPROCESS_TERM_GRACE_MS,
    hardTimeoutMs: QUIT_SUBPROCESS_HARD_TIMEOUT_MS
  }
  quitSubprocessCleanupPromise = (async () => {
    try {
      beginTerminalShutdown()
      // Kill held warm shells and suppress re-arm before the pty sweep runs.
      teardownAllWarm()
    } catch (err) {
      console.error('[main] quit subprocess cleanup failed in beginTerminalShutdown:', err)
    }
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['shutdownAllPtys', () => shutdownAllPtys(opts)],
      ['shutdownChatTransports', () => shutdownChatTransports(opts)],
      ['shutdownAllProcesses', () => shutdownAllProcesses(opts)]
    ]
    const results = await Promise.all(
      steps.map(async ([name, fn]) => {
        try {
          return [name, await fn()] as const
        } catch (err) {
          console.error(`[main] quit subprocess cleanup failed in ${name}:`, err)
          return [name, null] as const
        }
      })
    )
    recordDiagnosticEvent({
      level: 'info',
      source: 'main',
      event: 'app.quit_subprocess_shutdown',
      payload: Object.fromEntries(results)
    })
  })()
  return quitSubprocessCleanupPromise
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
    try {
      appendFileSync(file, line + '\n')
    } catch {
      /* best effort */
    }
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
    lines.push(
      `[boot]   Δ=${String(s.delta).padStart(5)}ms  t=${String(s.t).padStart(5)}ms  ${s.step}`
    )
  }
  for (const l of lines) console.log(l)
  const file = bootLogFilePath()
  if (file) {
    try {
      appendFileSync(file, lines.join('\n') + '\n')
    } catch {
      /* best effort */
    }
  }
}

function applyAppZoom(command: AppZoomCommand): number {
  if (!mainWindow || mainWindow.isDestroyed()) return 1

  const wc = mainWindow.webContents
  const nextLevel =
    command === 'reset'
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
  menuEvents.emit('zoom-factor-changed', zoomFactor)
  wc.send('app:zoom-factor-changed', zoomFactor) // slice 5: drop legacy send
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
  presentWindow(mainWindow)

  const waiter = oauthCallbackWaiters.values().next().value as
    | ((p: OAuthCallbackPayload) => void)
    | undefined
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

// System GitHub OAuth sign-in flow. Shared by the `auth:github-system-sign-in`
// IPC handler and the tRPC `app.auth.githubSystemSignIn` mutation (coexistence
// until slice 5) — single implementation, both transports delegate here.
async function githubSystemSignIn(input: { convexUrl: string; redirectTo: string }): Promise<
  | { ok: false; error: string; verifier?: string }
  | { ok: true; verifier: string; code: string }
> {
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

    // Shared with the chromium-fork sidecar — single PKCE-handshake impl. The
    // transport/server barrel is already loaded by boot, so this resolves the
    // cached module instantly.
    const { requestGithubSignInStart } = await import('@slayzone/transport/server')
    const start = await requestGithubSignInStart(input.convexUrl, input.redirectTo, 'electron-main')
    await shell.openExternal(start.redirect)

    const callback = await waitForOAuthCallback(OAUTH_CALLBACK_TIMEOUT_MS)
    if (callback.error) {
      return { ok: false, verifier: start.verifier, error: callback.error }
    }
    if (!callback.code) {
      return {
        ok: false,
        verifier: start.verifier,
        error:
          'GitHub sign-in failed — no authorization code returned. Try again or use a different browser.'
      }
    }
    return { ok: true, verifier: start.verifier, code: callback.code }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'GitHub sign-in failed'
    }
  }
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
    menuEvents.emit('open-task', { taskId })
    presentWindow(mainWindow)
    return
  }

  const isAuthCallback =
    (parsed.hostname === 'auth' && normalizedPath === '/callback') ||
    // Some platforms can normalize custom URLs as slayzone:///auth/callback
    (parsed.hostname === '' && normalizedPath === '/auth/callback')
  if (!isAuthCallback) return

  const hashParams = new URLSearchParams(
    parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
  )
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
  console.error(
    '[app] Failed to acquire single-instance lock; quitting duplicate instance',
    lockOutcome
  )
  app.quit()
} else if (shouldEnforceSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    handleOAuthDeepLinkFromArgv(argv)
    presentWindow(mainWindow)
  })
}

// On macOS, protocol launches are delivered via open-url.
// Register before app ready so early callback events are not missed.
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleOAuthDeepLink(url)
})

function emitOpenSettings(): void {
  menuEvents.emit('open-settings')
}

function emitOpenProjectSettings(): void {
  menuEvents.emit('open-project-settings')
}

function emitNewTemporaryTask(): void {
  menuEvents.emit('new-temporary-task')
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
    if (result.pathNotInPATH)
      msg += `\n\nNote: ${getCliBinTarget()} dir is not in your PATH. Add it to use 'slay' from any terminal.`
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
    .catch(() => {
      splashWindow?.close()
    })
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

  splashWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(splashHTML(app.getVersion()))}`
  )

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

  // Floating global agent panel: register main window with state machine adapter
  attachFloatingGlobalAgentPanel(mainWindow)
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
      menuEvents.emit('go-home')
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
      menuEvents.emit('screenshot-trigger')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('reload-browser', currentOverrides))) {
      event.preventDefault()
      menuEvents.emit('reload-browser')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('reload-app', currentOverrides))) {
      event.preventDefault()
      menuEvents.emit('reload-app')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('global-agent-panel', currentOverrides))) {
      event.preventDefault()
      menuEvents.emit('toggle-global-agent-panel')
    }

    if (matchesElectronInput(ei, getEffectiveKeys('agent-status-panel', currentOverrides))) {
      event.preventDefault()
      menuEvents.emit('toggle-agent-status-panel')
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
    try {
      if (win.isDestroyed() || !win.webContents.mainFrame) return
    } catch {
      return
    }
    try {
      originalSend(channel, ...args)
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('frame was disposed'))) throw err
    }
  }
})

app
  .whenReady()
  .then(async () => {
    logBoot('whenReady begin')

    // Pre-boot server-mode config (slice 7). A tiny JSON file — NOT a settings
    // row, since in remote mode the settings DB lives on the remote server.
    // Local (default): everything below runs as always. Remote: the local
    // backend machinery (in-process tRPC, MCP/REST for the CLI, the sidecar,
    // integration pollers + push handlers) is skipped — the renderer connects
    // to the user-configured remote @slayzone/hub, which owns all of that.
    const bootConfig = readBootConfig(getClientStateRoot(), getLegacyClientStateRoot())
    // `server_mode` is authoritative for whether the embedded local hub runs:
    // `local` = spawn the sidecar, `remote` = don't (this machine is a pure
    // client). This holds under multi_hub too — the "Run a local hub" toggle in
    // the Hubs UI writes server_mode. Remote hubs are dialed from the renderer's
    // FederationProvider regardless. Guard mirrors resolveHubRegistry: with
    // multi_hub on + local off + NO remotes, we still spawn local (the registry
    // keeps local so the app has a hub) — but that degenerate config can't be
    // produced by the UI (it forbids removing the last hub).
    const isRemoteMode = bootConfig.server_mode === 'remote'
    logBoot(
      `server mode: ${bootConfig.server_mode}${bootConfig.multi_hub ? ' (multi_hub)' : ''}${isRemoteMode ? ` (${bootConfig.remote_server_url ?? 'remotes from registry'})` : ''}`
    )
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

    // Initialize databases. The worker thread owns the only better-sqlite3
    // connection and runs the entire bring-up sequence — legacy file migration,
    // pragmas, pre-migration backup, schema migrations, status normalization and
    // terminal-mode sync — before initDatabases() resolves. No query can race
    // ahead of migrations, so nothing here needs to re-run those steps.
    logBoot('database init start')
    const { diagDb } = await initDatabases()
    // Move the client-scoped keys out of the shared DB, once per channel, then
    // read them from the client store for the rest of boot. Everything below that
    // used to hit `settings` for these is now reading a local file — which is what
    // lets it happen before any hub exists, and fixes remote mode, where main was
    // reading a local database while the renderer wrote to the remote one.
    const clientRoot = getClientRoot()
    try {
      const migrated = await migrateClientSettings({ clientRoot, dbPath: getDatabasePath() })
      if (migrated.status === 'migrated' && migrated.keys.length > 0) {
        logBoot(`client settings migrated: ${migrated.keys.join(', ')}`)
      }
    } catch (err) {
      // No sentinel was written, so the next boot retries. Surfacing beats
      // silently continuing with defaults for theme/shortcuts.
      console.error('[client-settings] migration failed, will retry next boot:', err)
    }
    let clientSettings = readClientSettings(clientRoot)
    logBoot('db opened')
    // Pre-warm keys used by synchronous IPC handlers (event.returnValue).
    // Migrations (run in the worker) have already seeded defaults by now.
    // The four `terminal_*` idle/prewarm keys used to be warmed here too. Their
    // only host readers were the duplicate idle-close + warm-pool wiring below,
    // which swept an empty session registry — the side-car owns both. They govern
    // agents running on a runner, so they stay hub-side and the host stops
    // reading them at all. The two `labs_*` flags now come from the client store.
    logBoot('migrations applied')

    // v127 disk-dir migration: assets/ → artifacts/. Idempotent.
    // Earlier v127 builds shipped a no-op rename (both vars = 'artifacts') that
    // left user content orphaned in assets/. This block recovers from that and
    // also handles fresh upgrades. See db/v127-disk-migration.ts.
    {
      const dataDir = getStorageDir()
      try {
        const report = migrateV127DiskDir(join(dataDir, 'assets'), join(dataDir, 'artifacts'))
        if (report.mode !== 'noop') {
          console.log(
            `[migration v127] disk: mode=${report.mode} taskDirsMoved=${report.taskDirsMoved} filesMoved=${report.filesMoved} conflicts=${report.conflicts} oldDirRemoved=${report.oldDirRemoved}`
          )
        }
      } catch (e) {
        console.error('[migration v127] disk dir migration failed', e)
      }
    }
    logBoot('v127 disk migration done')

    // Artifact v1 seeding moved to the SIDE-CAR's boot (composition.ts
    // `artifact-version-seed`). It is a domain txn, so the hub dispatches it
    // unchanged — and running it there also means a STANDALONE hub finally seeds,
    // which it never did while this lived on the Electron host.
    logBoot('artifact versions seeded')
    logBoot('diagnostics db opened')
    const isLabEnabled = (key: string): boolean => {
      const raw =
        key === 'labs_tests_panel' ? clientSettings.labs?.testsPanel : clientSettings.labs?.loopMode
      if (raw === undefined) return is.dev || isPlaywright
      return raw
    }
    logBoot('database init complete')

    // Lifecycle: detect prior crash via boot sentinel + arm sentinel for this run.
    // Pure fs (no DB needed). recordDiagnosticEvent buffers until handlers register.
    const { crashed: previousCrashed, prevBoot } = detectPreviousCrash()
    writeBootStub()
    recordDiagnosticEvent({
      level: 'info',
      source: 'main',
      event: 'app.boot.start',
      payload: { version: app.getVersion(), pid: process.pid, platform: process.platform }
    })
    if (previousCrashed && prevBoot) {
      const minidumps = scanCrashDumps(prevBoot.ts)
      recordDiagnosticEvent({
        level: 'error',
        source: 'main',
        event: 'app.crash.detected_on_next_boot',
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

    // Onboarding baseline for e2e is seeded by the SIDE-CAR at its own boot
    // (composition.ts `e2e-onboarding-seed`) — deterministic, and the host has no
    // DB handle to do it with.

    registerProcessDiagnostics(app)
    logBoot('process diagnostics registered')

    // Migrate CLI symlink from /usr/local/bin to ~/.local/bin on Linux
    if (process.platform === 'linux') {
      const cliMigration = migrateCliBinIfNeeded(getCliSrc())
      if (
        cliMigration.status === 'migrated-old-kept' &&
        (await markCliMigrationDialogShownLocally())
      ) {
        dialog.showMessageBox({
          type: 'info',
          title: 'CLI symlink migrated',
          message: `The slay CLI was installed at ${cliMigration.newPath}, but the old symlink at ${cliMigration.oldPath} couldn't be removed.`,
          detail: `Run: sudo rm ${cliMigration.oldPath}`
        })
      }
    }

    // Load and apply persisted theme BEFORE creating window to prevent flash
    nativeTheme.themeSource = clientSettings.theme ?? 'dark'
    logBoot('theme loaded')

    function getMenuAccelerator(
      id: string,
      overrides: Record<string, string | null>
    ): string | undefined {
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
              click: () => {
                menuEvents.emit('sync-session-id')
              }
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
              click: () => {
                menuEvents.emit('reload-browser')
              }
            },
            {
              label: 'Reload App',
              accelerator: 'CmdOrCtrl+Shift+R',
              registerAccelerator: false,
              click: () => {
                menuEvents.emit('reload-app')
              }
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
                menuEvents.emit('close-current-focus')
              }
            },
            {
              label: 'Close Task',
              accelerator: getMenuAccelerator('close-task', overrides),
              click: () => {
                menuEvents.emit('close-active-task')
              }
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

    currentOverrides = readClientSettings(clientRoot).customShortcuts ?? {}
    buildAppMenu(currentOverrides)
    logBoot('app menu built')

    // Rebuild menu + update overrides cache whenever shortcuts change
    ipcMain.on('shortcuts:changed', async () => {
      currentOverrides = readClientSettings(clientRoot).customShortcuts ?? {}
      buildAppMenu(currentOverrides)
    })

    // Bind diagnostics first so tRPC diagnostics works and IPC below is instrumented.
    // Flushes any events buffered before this point (boot.start, crash detect, lock outcome).
    registerDiagnosticsHandlers(ipcMain, diagDb, { enableIpcHandlers: isPlaywright })
    setIpcSuccessHook((channel, args, result) => {
      const entry = IPC_TELEMETRY_MAP[channel]
      if (!entry) return
      const props = entry.props(args, result)
      if (props === undefined) return
      telemetryEvents.emit('ipc-event', entry.event, props) // tRPC telemetry.onIpcEvent source
    })
    logBoot('diagnostics IPC registered')

    configureTaskRuntimeAdapters({
      killPtysByTaskId,
      killTaskProcesses,
      recordDiagnosticEvent,
      requestPtyRespawn: broadcastRespawnRequest,
      onReachedTerminal: onTaskReachedTerminal,
      // Data-root seam so task ops/ stays server-pure. MUST be the resolved
      // storage dir (this app's channel-scoped hub root), NOT
      // app.getPath('userData') — post-migration artifacts live under
      // <hub-root>/artifacts, so a userData-based root would strand deleted-task
      // artifact cleanup at the empty legacy dir.
      getDataRoot: () => getStorageDir()
    })
    // Wire the cross-domain terminal seam so server-pure callers (integrations
    // sync) reach the real pty-killing impl.
    setOnTaskReachedTerminalHandler(onTaskReachedTerminal)
    logBoot('task runtime adapters configured')

    // The host-kill timestamp is stamped by the SIDE-CAR (host-kill.ts), which
    // owns the pty sessions `onHostKillHandler` fires from. The host registered it
    // against its own empty session registry, so it never ran in local mode.

    // Register domain handlers (inject ipcMain and db)
    const notifyTasksChanged = (): void => {
      notifyEvents.emit('tasks-changed') // tRPC notify.onTasksChanged source
    }

    // Conversation healer + resolver are registered by the SIDE-CAR
    // (composition.ts:361-362) — it owns the pty runtime, so it is the process
    // where a resume actually builds `--resume`. The host copies registered
    // against the same shared DB and were never consulted.
    logBoot('core domain ops built')

    // Single OS→app theme listener. Both the tRPC `settings.onThemeChanged`
    // subscription and native OS theme changes derive from this one bus.
    wireNativeThemeBridge()
    const usageOps = buildUsageOps()
    // Warm-process tab-count cleanup on window death — covers both the IPC and
    // tRPC push paths (registered before any renderer window is created).
    wireWarmWindowCleanup(app)
    logBoot('terminal runtime wired')

    setupFloatingGlobalAgentPanel(() => currentOverrides, { enableIpcHandlers: isPlaywright })
    setupTaskWindows({ enableIpcHandlers: isPlaywright })
    logBoot('floating global agent panel + task windows set up')

    // Terminal-state automation (auto-move on state change + the attention flag)
    // is registered in the SIDE-CAR (composition.ts:377). `onGlobalStateChange`
    // fires on whichever process owns the pty sessions; the host owns none, so its
    // listener was registered against its own bundled pty-manager copy and never
    // fired. Same orphaning as idle-close, the warm pool and `was_spawned`.

    // Expose test helpers for e2e
    if (isPlaywright) {
      // `__db` keeps its old shape so the four specs that use it inside
      // `electronApp.evaluate(...)` are unchanged — but it is a FORWARDER now, not
      // a handle. Each call POSTs to the side-car's E2E-gated `/api/dev/sql`, so
      // the host answers e2e's database questions without opening a database.
      ;(globalThis as Record<string, unknown>).__db = {
        get: (sql: string, params?: unknown[]) => devSql('get', sql, params),
        all: (sql: string, params?: unknown[]) => devSql('all', sql, params),
        run: (sql: string, params?: unknown[]) => devSql('run', sql, params),
        exec: (sql: string) => devSql('exec', sql)
      }
      // Forwarders, like `__db` above. The pty state listeners AND the user-input
      // mark they gate on both live in the side-car; firing these in the host
      // reached its own empty registry and silently did nothing.
      ;(globalThis as Record<string, unknown>).__notifyPtyState = (
        sid: string,
        next: string,
        prev: string
      ) => devPost('/api/dev/pty-state', { sid, next, prev })
      ;(globalThis as Record<string, unknown>).__markSessionUserInput = (sid: string) =>
        devPost('/api/dev/user-input-mark', { sid, mark: true })
      ;(globalThis as Record<string, unknown>).__clearSessionUserInputMark = (sid: string) =>
        devPost('/api/dev/user-input-mark', { sid, mark: false })
    }

    // The per-tab `was_spawned` / `hibernated` recorders are installed by the
    // SIDE-CAR (`wireTabFlagRecorders`, composition.ts:487) — the process that
    // actually spawns sessions. The host's copies fired against its own empty
    // registry, which is exactly the bug `tab-flag-recorders.test.ts` was written
    // to pin: `was_spawned` stayed 0 forever and a restart restored nothing.
    //
    // The pty enricher is wired in the SIDE-CAR too now (composition.ts), where
    // the sessions it decorates actually live. `createPtyEnricher` moved to
    // `task-terminals/server` — it imports only `SlayzoneDb`, so being filed under
    // /electron was the whole reason the side-car could not wire it.
    // Spawn-time hook self-heal: re-run the version-gated notify.sh installer
    // just before a hook-driven agent spawns, so a stale cross-release-channel copy left
    // on the SHARED ~/.slayzone/hooks/notify.sh between boots is repaired UPWARD
    // just-in-time (the gate guarantees no downgrade; a byte-match is a no-op).
    // Dynamic import mirrors the boot-time installer and keeps the agent-hooks
    // graph off the hot import path. `installNotifyScript` writes under
    // getSlayzoneHomeDir() (honors SLAYZONE_ROOT) so E2E stays sandboxed.
    setReinstallHooks(async () => {
      const [{ installNotifyScript }, { NOTIFY_SCRIPT_SOURCE }] = await Promise.all([
        import('@slayzone/platform/agent-hooks'),
        import('./agent-hooks/sources')
      ])
      await installNotifyScript({ source: NOTIFY_SCRIPT_SOURCE })
    })
    // Idle-close config and the warm-process pool are wired in the SIDE-CAR
    // (composition.ts:509 and :547), which owns the pty runtime and the routing
    // PtyBackend. The host's copies were registered on its OWN module singletons —
    // `checkInactiveSessions` sweeps this process's session registry, which holds
    // nothing, and the pool was constructed with `resolveRunnerId: async () => null`,
    // i.e. explicitly unable to warm anything. Two registrations of the same
    // module-global also meant whichever process wrote last silently won.
    //
    // These were the only readers of `terminal_auto_close_idle`,
    // `terminal_idle_close_value`, `terminal_idle_close_unit` and
    // `terminal_prewarm_enabled` in the host, which is why those four keys are
    // gone from `warmCache` above: they govern agents running on a runner and
    // belong to the hub.
    logBoot('terminal tab runtime wired')
    // Chat ops, the chat/pty turn subscribers and the `chatMode` backfill all run
    // in the SIDE-CAR, which owns the pty + chat runtime. The host's copies were
    // constructed against the shared DB and read by nothing.
    logBoot('ai-config tRPC-only')
    // Inject the Electron safeStorage cipher into the electron-free credential store.
    setCredentialCipher(getSafeStorageCipher())
    // Same cipher backs the per-hub bearer-token store (multi-hub auth).
    setHubTokenCipher(getSafeStorageCipher())
    // Integration schema + ops live in the side-car (composition.ts), which is
    // where the sync pollers and push handlers now run too.
    logBoot('integration ops owned by the hub')
    logBoot('misc tRPC ops built')
    // Never started here. The side-car owns the single AutomationEngine — it is
    // the process that sees every task mutation (renderer tRPC and CLI/MCP REST
    // both run there, and taskEvents is process-local). The remote-mode branch
    // that used to start one here ran against the LOCAL database, which in remote
    // mode has no tasks and therefore no triggers to fire; the remote hub runs its
    // own. `powerMonitor` is host-only, so wake still forwards over the bridge.
    powerMonitor.on('resume', () => powerResumeEvents.emit('resume'))
    // Reclaim Blink/Oilpan garbage on busy renderers that never go idle (see
    // proactive-gc.ts). No-op under Playwright.
    startProactiveGc()
    logBoot('domain tRPC ops registered')

    // Slice 9 local cutover: the renderer connects to the SIDE-CAR for data; the
    // host serves a bridge the side-car forwards Electron-only calls
    // to. The data-dep registry sets below are now harmless no-ops on the host
    // (no in-process appRouter server reads them) — left in place to minimise
    // churn; only setAppDeps/setMenuEvents/setPowerResumeEvents back the bridge.
    // Remote mode: skipped (renderer connects to the remote server).
    if (!isRemoteMode) setImmediate(() => {
      logBoot('host capability server import dispatched')
      import('@slayzone/transport/server')
        .then(async (mod) => {
          // The chat / pty / integration data-dep registries are NOT set here.
          // Nothing in this process reads them — the renderer talks to the side-car,
          // which populates its own from its own db. Setting them only required the
          // host to construct db-backed ops it never used, which is precisely the
          // dependency this change removes.
          //
          // Task CRUD/deps/board ops for the task router (electron-coupled → injected;
          // artifacts/template stores are electron-free + imported directly). Same ops
          // the IPC handlers call — one implementation, both transports.
          mod.setTaskDeps({ ops: taskOps, onMutation: notifyTasksChanged })
          // Cross-domain notify bus — same instance `notifyRenderer()` + the
          // legacy IPC broadcast emit on, so `notify.*` subs and IPC coexist
          // (renderer cutover is slice 5).
          mod.setNotifyEvents(notifyEvents)
          // Automations-changed + telemetry IPC-event buses — same host-owned
          // emitters the legacy `automations:changed` / `telemetry:ipc-event`
          // sends dual-emit on, so the `automations.onChanged` /
          // `telemetry.onIpcEvent` subs and IPC coexist (bridge drops later).
          mod.setAutomationsEvents(automationsEvents)
          mod.setTelemetryEvents(telemetryEvents)
          // Menu / app-shortcut bus — native menus, the before-input-event
          // accelerator handler, the auto-updater, and protocol deep-links emit
          // here. Post-cutover the host capability bridge streams these to the
          // side-car, whose `menu.*` subscriptions deliver them to the renderer.
          mod.setMenuEvents(menuEvents)
          mod.setAgentLifecycleEvents(agentLifecycleEvents)
          // Power-resume bus — host `powerMonitor 'resume'` (see above) forwarded
          // over the capability bridge so the side-car engine runs cron catchup.
          mod.setPowerResumeEvents(powerResumeEvents)
          // App-level ops — the SAME single instances the IPC handlers built and
          // returned above (backupOps/exportImportOps/usageOps/feedbackOps). One
          // implementation, both transports coexist (renderer cutover is slice 5).
          mod.setAppDeps({
            clipboardWriteFilePaths: writeFilePaths,
            clipboardReadFilePaths: readFilePaths,
            clipboardHasFiles: hasFilePaths,
            screenshotCaptureView: (viewId: string) =>
              captureBrowserViewScreenshot(browserViewManager, viewId),
            usageFetch: usageOps.fetch,
            usageTest: usageOps.test,
            filesPathExists,
            filesSaveTempImage,
            shellOpenExternal: (url, options) =>
              shellOpenExternal(
                url,
                options as
                  | { blockDesktopHandoff?: boolean; desktopHandoff?: DesktopHandoffPolicy }
                  | undefined
              ),
            shellOpenPath,
            shellShowItemInFolder: (absPath: string) => shell.showItemInFolder(absPath),
            // Backup restore overwrites the DB file in the side-car, then needs
            // everything pointing at it restarted. Relaunch is the desktop's job.
            appRelaunch: () => {
              app.relaunch()
              app.exit()
            },
            // The side-car saved a diagnostics config; adopt it here so THIS
            // process stops (or starts) recording into the machine-local
            // diagnostics DB to match. Goes through saveDiagnosticsConfig rather
            // than writing the client store directly so the in-process config
            // cache — the synchronous hot path every recordDiagnosticEvent
            // consults — is updated in the same step.
            diagnosticsConfigChanged: async (next) => {
              await saveDiagnosticsConfig(next)
            },
            appGetVersion: () => app.getVersion(),
            appGetDownloadsDir: async () => app.getPath('downloads'),
            // Offscreen renderers, reached from the hub over the capability bridge.
            artifactBuildExportHtml: async (content, mode, title) =>
              mode === 'mermaid-preview'
                ? buildMermaidPdfHtml(content, title)
                : buildPdfHtml(content, mode, title),
            artifactRenderPdfToFile: async (content, mode, title, destPath) => {
              const isMermaid = mode === 'mermaid-preview'
              const html = isMermaid
                ? buildMermaidPdfHtml(content, title)
                : buildPdfHtml(content, mode, title)
              writeFileSync(destPath, await renderToPdf(html, isMermaid))
            },
            artifactRenderPngToFile: async (content, mode, title, destPath) => {
              const html = buildPngHtml(content, mode, title)
              if (!html) return false
              writeFileSync(destPath, await renderToPng(html))
              return true
            },
            // Task/tab browser registry, reached from the hub over the capability
            // injects into the REST browser routes. One implementation, two
            // bridge. Sole injection point since the REST proxy was deleted.
            browserTabs: {
              getResolvedTabId: async (taskId, tabId) => getResolvedBrowserTabId(taskId, tabId),
              listTabs: async (taskId) => listBrowserTabs(taskId),
              hasTab: async (taskId, tabId) => hasBrowserTab(taskId, tabId),
              waitForRegistration: (taskId, opts) => awaitBrowserRegistration(taskId, opts),
              execJs: (taskId, tabId, code) => browserExecJs(taskId, tabId, code),
              loadUrl: (taskId, tabId, url) => browserLoadUrl(taskId, tabId, url),
              getUrl: (taskId, tabId) => browserGetUrl(taskId, tabId),
              capturePageToFile: (taskId, tabId, destPath) =>
                browserCapturePageToFile(taskId, tabId, destPath)
            },
            appGetTrpcPort: () => awaitTrpcPort(),
            appIsTestsPanelEnabled: () => isLabEnabled('labs_tests_panel'),
            appSetLabFlag: async (key, on) => {
              const next =
                key === 'labs_tests_panel'
                  ? { testsPanel: on, loopMode: clientSettings.labs?.loopMode }
                  : { testsPanel: clientSettings.labs?.testsPanel, loopMode: on }
              await updateClientSettings({ labs: next }, clientRoot)
              clientSettings = readClientSettings(clientRoot)
            },
            appIsLoopModeEnabled: () => isLabEnabled('labs_loop_mode'),
            appGetZoomFactor: () => mainWindow?.webContents.zoomFactor ?? 1,
            appGetProtocolClientStatus: () => protocolClientStatus,
            appGetRendererZoomFactor: () => mainWindow?.webContents.zoomFactor ?? null,
            appCheckCliInstalled: () => checkCliInstalled(),
            appInstallCli: () => installCli(getCliSrc()),
            appAdjustZoom: (command) => applyAppZoom(command),
            appRestartForUpdate: () => restartForUpdate(),
            appCheckForUpdates: () => checkForUpdates(),
            appRebuildMenuForShortcuts: () => {
              void (async () => {
                currentOverrides = readClientSettings(clientRoot).customShortcuts ?? {}
                buildAppMenu(currentOverrides)
              })()
            },
            appGetSidecarStatus: getSidecarStatusSnapshot,
            appRevealSidecarLog: revealSidecarLogInFinder,
            appWindowGetContentBounds: () => mainWindow?.getContentBounds() ?? null,
            appWindowGetDisplayScaleFactor: () => {
              if (!mainWindow || mainWindow.isDestroyed()) return null
              return screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor
            },
            authGithubSystemSignIn: (input) => githubSystemSignIn(input),
            dialogShowOpenDialog: (options) =>
              dialog.showOpenDialog(options as Electron.OpenDialogOptions),
            // Parent the save sheet to the focused window when there is one —
            // the side-car has no window handle to pass, so the choice is made
            // here rather than threaded across the bridge.
            dialogShowSaveDialog: (options) => {
              const opts = options as Electron.SaveDialogOptions
              const focused = BrowserWindow.getFocusedWindow()
              return focused
                ? dialog.showSaveDialog(focused, opts)
                : dialog.showSaveDialog(opts)
            },
            windowClose: (windowId) => {
              const wc = webContents.fromId(windowId)
              const win = wc ? BrowserWindow.fromWebContents(wc) : null
              if (win) win.close()
            },
            appWindowSetTrafficLightPosition: (windowId, pos) => {
              if (process.platform !== 'darwin' || windowId == null) return
              const wc = webContents.fromId(windowId)
              const win = wc ? BrowserWindow.fromWebContents(wc) : null
              if (win) win.setWindowButtonPosition(pos ?? { x: 10, y: 12 })
            },
            appWindowSetWindowButtonVisibility: (windowId, visible) => {
              if (process.platform !== 'darwin' || windowId == null) return
              const wc = webContents.fromId(windowId)
              const win = wc ? BrowserWindow.fromWebContents(wc) : null
              if (win) win.setWindowButtonVisibility(visible)
            },
            appFocusRenderer: (windowId) => {
              if (windowId == null) return
              const wc = webContents.fromId(windowId)
              const win = wc ? BrowserWindow.fromWebContents(wc) : null
              if (!wc || !win || win.isDestroyed() || !win.isFocused()) return
              wc.focus()
            },
            // Raise/show+focus the main window — the CLI/agent `tasks/open`
            // foreground path, forwarded from the side-car REST over the bridge.
            appRaiseMainWindow: () => {
              presentWindow(mainWindow ?? BrowserWindow.getAllWindows()[0])
            },
            // Theme — Electron nativeTheme. The side-car's `settings.*Theme`
            // procedures forward here over the bridge; `theme:changed` streams
            // back (wireNativeThemeBridge → settingsEvents → bridge `theme` chan).
            themeGetEffective: () => nativeGetEffectiveTheme(),
            themeGetSource: () => nativeGetThemeSource(),
            themeSet: (pref) => nativeSetTheme(pref),
            // Credential cipher — Electron safeStorage. The side-car runs as
            // ELECTRON_RUN_AS_NODE (no safeStorage), so its credential store
            // forwards encrypt/decrypt here over the bridge. Base64 on the wire.
            credentialCipher: {
              isEncryptionAvailable: () => getSafeStorageCipher()?.isEncryptionAvailable() ?? false,
              encryptStringToB64: (secret) => {
                const c = getSafeStorageCipher()
                if (!c)
                  throw new Error('OS secure credential storage is unavailable on this machine')
                return c.encryptString(secret).toString('base64')
              },
              decryptStringFromB64: (b64) => {
                const c = getSafeStorageCipher()
                if (!c)
                  throw new Error('OS secure credential storage is unavailable on this machine')
                return c.decryptString(Buffer.from(b64, 'base64'))
              }
            },
            // Browser view ops — same BrowserViewManager singleton + shared
            // browserExtensionOps the `browser:*` IPC handlers use (coexistence
            // until slice 5). browserExtensionOps is defined below in this
            // app.whenReady scope; these closures only run after it inits.
            browser: {
              createView: (opts) => browserViewManager.createView(opts as never),
              destroyView: (viewId) => browserViewManager.destroyView(viewId),
              destroyAllForTask: (taskId) => browserViewManager.destroyAllForTask(taskId),
              setBounds: (viewId, bounds) => browserViewManager.setBounds(viewId, bounds as never),
              setVisible: (viewId, visible) => browserViewManager.setVisible(viewId, visible),
              setLocked: (viewId, locked) => browserViewManager.setLocked(viewId, locked),
              hideAll: () => browserViewManager.hideAll(),
              showAll: () => browserViewManager.showAll(),
              setHandoffPolicy: (viewId, policy) =>
                browserViewManager.setHandoffPolicy(viewId, policy as never),
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
              findInPage: (viewId, text, options) =>
                browserViewManager.findInPage(viewId, text, options as never),
              stopFindInPage: (viewId, action) => browserViewManager.stopFindInPage(viewId, action),
              setKeyboardPassthrough: (viewId, enabled) =>
                browserViewManager.setKeyboardPassthrough(viewId, enabled),
              sendInputEvent: (viewId, input) =>
                browserViewManager.sendInputEvent(viewId, input as never),
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
              activateExtension: (extensionId) => browserExtensionOps.activateExtension(extensionId),
              getExtensions: () => browserExtensionOps.getExtensions(),
              loadExtension: () => browserExtensionOps.loadExtension(),
              removeExtension: (extensionId) => browserExtensionOps.removeExtension(extensionId),
              discoverBrowserExtensions: () => browserExtensionOps.discoverBrowserExtensions(),
              importExtension: (extPath) => browserExtensionOps.importExtension(extPath),
              reparentToCurrentWindow: (viewId) => {
                const win = BrowserWindow.getFocusedWindow() ?? mainWindow
                if (win) browserViewManager.reparentView(viewId, win)
              },
              getAllStateSnapshots: () => browserViewManager.getAllStateSnapshots(),
              events: browserViewEvents
            },
            floatingAgent: {
              ...floatingGlobalAgentPanelOps,
              events: floatingGlobalAgentPanelEvents
            },
            webview: {
              registerBrowserTab,
              unregisterBrowserTab,
              setActiveBrowserTab,
              closeDevTools: (webviewId) => webviewOps.closeDevTools(webviewId),
              isDevToolsOpened: (webviewId) => webviewOps.isDevToolsOpened(webviewId),
              disableDeviceEmulation: (webviewId) => webviewOps.disableDeviceEmulation(webviewId),
              // tRPC has no caller renderer to IPC-send to — only emits via
              // webviewEvents (the onShortcut sub delivers to subscribers).
              registerShortcuts: (webviewId) => webviewOps.registerShortcuts(webviewId),
              setKeyboardPassthrough: (webviewId, enabled) =>
                webviewOps.setKeyboardPassthrough(webviewId, enabled),
              setDesktopHandoffPolicy: (webviewId, policy) =>
                webviewOps.setDesktopHandoffPolicy(webviewId, policy as DesktopHandoffPolicy | null),
              openDevToolsBottom: (webviewId, options) =>
                webviewOps.openDevToolsBottom(webviewId, options),
              openDevToolsDetached: (webviewId) => webviewOps.openDevToolsDetached(webviewId),
              enableDeviceEmulation: (webviewId, params) =>
                webviewOps.enableDeviceEmulation(webviewId, params),
              events: webviewEvents
            },
            taskWindows: {
              ...taskWindowsOps,
              events: taskWindowsEvents
            }
          })
          // Process-manager lifecycle ops + the dual-emit event stream for the
          // processes router. Same module-singleton ops/emitter the IPC handlers
          // delegate to → one implementation, both transports (slice 5 cutover).
          mod.setProcessesDeps({
            create: createProcess,
            spawn: spawnProcess,
            update: updateProcess,
            stop: stopProcess,
            kill: killProcess,
            restart: restartProcess,
            listForTask,
            listAll: listAllProcesses,
            killTask: killTaskProcesses,
            events: processEvents
          })
          // Cutover: no in-process appRouter server. The desktop app serves ONE
          // bridge listener (setAppDeps/setMenuEvents/setPowerResumeEvents back it):
          //  • WS `/cap` — the side-car forwards its Electron-only AppDeps calls
          //    here and streams desktop menu/power events back (startTrpcServer retired).
          // That is now the ONLY thing it serves. The `/api/*` reverse-proxy is
          // gone: those routes run in the side-car against its own db and reach
          // back through `/cap` for the Electron step alone — so this listener no
          // longer needs a database handle at all. No discovery port is written
          // either; the side-car owns `server_port` (CLI/agents/MCP).
          const bridgeServer = await startDesktopBridgeServer({})
          bridgeCleanup = () => void bridgeServer.stop()
          resolveDesktopBridgeAddress(`127.0.0.1:${bridgeServer.port}`)
          logBoot(`desktop bridge server started (port ${bridgeServer.port}, cap WS only)`)
        })
        .catch((err) => {
          console.error('[desktop-bridge] Failed to start bridge server:', err)
        })
    })

    // Slice 9 LIVE side-car: the renderer now connects here for all data. The
    // side-car is spawned with the desktop bridge address so it can forward
    // Electron-only work back to the desktop app (capability calls over WS `/cap`
    // + browser/export REST over HTTP `/api/*`, one listener). We await the bridge
    // port before spawning.
    // A permanent failure surfaces via notify.onEmbeddedServerFailed (persistent toast).
    // Remote mode: skipped — the backend runs elsewhere.
    if (!isRemoteMode) setImmediate(() => {
      logBoot('sidecar server supervisor import dispatched')
      Promise.all([import('./sidecar-server-supervisor'), desktopBridgeAddressPromise])
        .then(([{ startSidecarServer }, desktopBridgeAddress]) => {
          const scriptPath = is.dev
            ? join(app.getAppPath(), '../hub/dist/bin.cjs')
            : join(process.resourcesPath, 'hub', 'bin.cjs')
          const supervisor = startSidecarServer({
            execPath: process.execPath,
            scriptPath,
            host: '127.0.0.1',
            // The supervised sidecar binds a FIXED port per channel, inside the
            // reserved head of HUB_PORT_BLOCK (51100-51109). That is what makes it
            // findable without a database: `slay` and `slay hub ls` reach it by
            // probing a known constant (or by the ordinary block sweep) instead of
            // reading `settings.server_port` out of the SQLite file — the only
            // reason the CLI still opened a DB at all. A bound port cannot go
            // stale, and only one process can hold it, so a stray second sidecar
            // now fails loud with EADDRINUSE instead of silently coexisting
            // against the same DB.
            //
            // NOT under Playwright: `e2e-parallel.sh` runs the full suite as one
            // process PER e2e/ SUBDIRECTORY — six concurrent Electron apps — so a
            // single fixed test port would EADDRINUSE five of them. (SIDECAR_FIXED_PORT
            // .test exists for a single-app run; paths.ts's "e2e is one worker" note
            // predates the group runner and is true only within one group.) E2E
            // keeps the OS-assigned port and the `settings.server_port` channel.
            fixedPort: isPlaywright
              ? undefined
              : SIDECAR_FIXED_PORT[app.isPackaged ? 'prod' : 'dev'],
            // Diagnostics only — the SAME derivation the sidecar performs from the
            // SLAYZONE_ROOT handed over below + the SLAYZONE_DEV bit, computed here
            // so the Diagnostics "Database" row can name the file.
            dbPath: getDatabasePath(),
            env: {
              ...process.env,
              // The sidecar IS this app's hub, so hand it this app's own
              // channel-scoped HUB root explicitly instead of letting it re-derive
              // an ambient one. It can't derive this itself: getSupervisedRoot is
              // desktop-app-only (a standalone hub anchors to its own --root), and
              // an inherited-unset SLAYZONE_ROOT would land it back on the flat,
              // channel-shared ~/.slayzone the migration just moved state out of.
              // Everything else it needs (DB path, logs, artifacts) derives from
              // this one var, so no path-pointing var is threaded, by design.
              SLAYZONE_ROOT: getSupervisedRoot('hub'),
              // Pass the dev-vs-packaged bit it can't infer (it has no Electron
              // `app.isPackaged`), so it derives the right DB filename.
              SLAYZONE_DEV: app.isPackaged ? undefined : '1',
              // Desktop bridge: one listener carrying the capability bridge (renderer
              // Electron-only calls + desktop events, WS `/cap`) AND the REST
              // reverse-proxy target (browser-automation + export, HTTP `/api/*`).
              // Authority only — always loopback, so the side-car derives ws/http.
              SLAYZONE_DESKTOP_BRIDGE_ADDRESS: desktopBridgeAddress,
              // Packaged resolution: only bin.js is copied to Resources/hub,
              // so createRequire's walk-up never finds node_modules. Point the
              // resolver at the unpacked natives (better-sqlite3, node-pty) the
              // app ships anyway — same ABI, ELECTRON_RUN_AS_NODE shares it.
              ...(app.isPackaged
                ? {
                    NODE_PATH: join(
                      process.resourcesPath,
                      'app.asar.unpacked',
                      'node_modules'
                    )
                  }
                : {})
              // The sidecar always builds the runner gateway/auth (a hub always
              // accepts runners) — no env flag needed. `/runners` rides the ONE hub
              // listener (same port as /trpc), demuxed by path; supervised binds
              // loopback (127.0.0.1), so the co-located runner reaches it locally.
            },
            logger: (line) => logBoot(line),
            onReady: (info) => {
              // Post-cutover the SIDE-CAR is the canonical MCP/REST backend. Point
              // the host's `__serverPort` at it so anything resolving the discoverable
              // port in the host process (e2e helpers, diagnostics) targets the
              // side-car — NOT the host's writePort:false reverse-proxy REST.
              ;(globalThis as Record<string, unknown>).__serverPort = info.port
            },
            onPermanentFailure: (info) => {
              console.error(
                '[supervisor] sidecar permanent failure (dark-launch, non-fatal):',
                info
              )
              const message = String(
                info.lastError instanceof Error ? info.lastError.message : info.lastError
              )
              // NATIVE dialog, deliberately not a renderer toast. The toast below
              // has never been reachable: this emits on the HOST's notifyEvents,
              // while the renderer subscribes to `notify.onEmbeddedServerFailed`
              // served by the SIDE-CAR — and if the side-car failed permanently
              // there is no bus to carry it. `dialog` needs no renderer, no window
              // and no hub, so it is the only surface that survives this failure.
              //
              // Load-bearing now that the hub owns schema migration: a migration
              // failure exits the side-car non-zero, and without this it would be
              // completely silent — a blank window that reads as data loss.
              // "Not been modified" is literally true: every migration is atomic
              // with its own user_version bump, so a crash leaves the DB at the
              // last fully-applied version with a backup beside it.
              dialog.showErrorBox(
                'SlayZone could not start its local server',
                `${message}\n\n` +
                  `Your data has not been modified. A pre-migration backup, if one was needed, ` +
                  `is in:\n${join(getStorageDir(), 'backups')}\n\n` +
                  `Log:\n${join(getStorageDir(), 'logs', 'sidecar.log')}\n\n` +
                  `Attempts: ${info.attempts}`
              )
              recordDiagnosticEvent({
                level: 'error',
                source: 'main',
                event: 'sidecar.permanent_failure',
                message,
                payload: { attempts: info.attempts }
              })
              // Kept: costs nothing and becomes correct if the two buses are ever
              // unified. Not the surface being relied on.
              notifyEvents.emit('embedded-server-failed', {
                attempts: info.attempts,
                message
              })
            },
            // Dev-only, opt-in: relaunch the side-car when its on-disk build
            // changes (server-src watcher rebuilds bin.cjs). Off by default so a
            // rebuild never surprises a live debug session; staleness still shows
            // in the Diagnostics tab regardless. Never enabled in a packaged app.
            hotRestartOnBuildChange:
              is.dev && process.env.SLAYZONE_SIDECAR_HOT_RESTART === '1'
          })
          sidecarServerHandle = supervisor
          resolveSidecarHandle(supervisor)
          sidecarCleanup = () => void supervisor.stop()
          logBoot('sidecar server supervisor started')
        })
        .catch((err) => {
          console.error('[sidecar] Failed to start supervisor:', err)
        })
    })

    // Local-runner supervisor. Spawns a co-located @slayzone/runner subprocess so
    // THIS machine can host runner work, pointed at the local hub's runner URL —
    // and AUTO-ENROLLS it with zero manual token. Always runs in local mode (a
    // hub always accepts runners; there is no mode to enable). Gated only on
    // local mode (remote mode has no local hub to dial).
    //
    // Runs under Playwright TOO. e2e is runner-ON by default because runners are
    // what run the agents — an e2e suite that boots runner-less exercises a
    // configuration the product does not have. A spec that genuinely needs a
    // runner-less hub (remote-mode, sidecar-crash, the "hub accepts runners with
    // no runner spawned" contract) opts OUT via `SLAYZONE_E2E_NO_RUNNER=1`.
    // The former opt-in `SLAYZONE_E2E_ALLOW_RUNNER` is no longer read here.
    // Off the boot critical path (setImmediate); failure is log-only.
    //
    // The auto-enroll resolves the ordering the wave-2 skeleton deferred: main has
    // NO tRPC client to the sidecar (the capability bridge only flows sidecar→main),
    // and the runner /runners wss URL is on an OS-assigned port main never learns.
    // So main waits for the sidecar to report ready, then mints a join token over
    // LOOPBACK REST (`POST /api/runners/join-token`, which wraps the same store
    // logic as the runners tRPC proc + returns the wss runner URL). It injects that
    // token + url into the runner env; the runner decodes the token → cert
    // fingerprint → dials wss with pinning → enrolls. If minting fails after
    // retries the runner is left UNSPAWNED — boot never crashes; the user can
    // still enroll remote runners via the UI.
    if (!isRemoteMode && process.env.SLAYZONE_E2E_NO_RUNNER !== '1') {
      setImmediate(() => {
        void ensureLocalRunnerStarted().catch((err) => {
          console.error('[local-runner] auto-enroll failed (local runner, non-fatal):', err)
        })
      })
    }

    // Install agent lifecycle hook script + Claude settings.json entries.
    // Off boot critical path; failures must NOT block app startup (logged only).
    // Skipped under Playwright unless the spec explicitly opts in — most E2E
    // tests share one Electron window and would otherwise mutate the dev user's
    // real ~/.claude/settings.json.
    if (!process.env.PLAYWRIGHT || process.env.SLAYZONE_E2E_INSTALL_HOOKS === '1') {
      setImmediate(async () => {
        try {
          // Defense-in-depth: under Playwright every hook installer must write
          // to a sandboxed path supplied by the e2e fixture. If a sandbox env
          // var is missing, the installer's `get*Path()` falls back to the dev
          // user's REAL home (~/.claude, ~/.antigravity, …) and silently
          // pollutes it. Fail loud + skip ALL installs rather than do that.
          // (Regression guard — a missing `SLAYZONE_ANTIGRAVITY_HOOKS_PATH`
          // once leaked SlayZone hooks into the real ~/.antigravity/hooks.json.)
          if (process.env.PLAYWRIGHT) {
            const sandboxVars = [
              'SLAYZONE_ROOT',
              'SLAYZONE_CLAUDE_SETTINGS_PATH',
              'SLAYZONE_CODEX_HOOKS_PATH',
              'SLAYZONE_GEMINI_SETTINGS_PATH',
              'SLAYZONE_ANTIGRAVITY_HOOKS_PATH',
              'SLAYZONE_OPENCODE_PLUGIN_PATH'
            ]
            const missing = sandboxVars.filter((v) => !process.env[v])
            if (missing.length > 0) {
              console.error(
                `[agent-hooks] refusing to install under PLAYWRIGHT — unsandboxed paths (missing: ${missing.join(', ')})`
              )
              return
            }
          }
          // One import now: the six installers were six sibling modules under
          // this app and are one shared entrypoint since the runner started
          // needing them too.
          const {
            installNotifyScript,
            installClaudeHooks,
            installCodexHooks,
            uninstallCodexWrapper,
            installGeminiHooks,
            installAntigravityHooks,
            installOpencodePlugin
          } = await import('@slayzone/platform/agent-hooks')
          // File bodies come from the app's own `?raw` seam — the shared
          // installers take them as input so they carry no bundler syntax.
          const { NOTIFY_SCRIPT_SOURCE, OPENCODE_PLUGIN_SOURCE } = await import(
            './agent-hooks/sources'
          )
          const { path: scriptPath } = await installNotifyScript({
            source: NOTIFY_SCRIPT_SOURCE
          })
          await installClaudeHooks({ scriptPath })
          await installCodexHooks({ scriptPath })
          // Remove the legacy ~/.slayzone/bin/codex bash wrapper from prior installs.
          await uninstallCodexWrapper()
          await installGeminiHooks({ scriptPath })
          await installAntigravityHooks({ scriptPath })
          await installOpencodePlugin({
            notifyPath: scriptPath,
            source: OPENCODE_PLUGIN_SOURCE
          })
          logBoot('agent hooks installed')
        } catch (err) {
          console.error('[agent-hooks] install failed:', err)
        }
      })
    }

    // Integration pollers + push-on-edit both live in the SIDE-CAR now
    // (composition.ts). The push listeners in particular were BROKEN here: the
    // task ops emit `db:tasks:*:done` on an INJECTED bus, and since slice 9 that
    // bus is the side-car's plain EventEmitter — never this process's `ipcMain`.
    // The pollers ran but their `notifyTasksChanged` went to the host's
    // notifyEvents, which the renderer (connected to the side-car) never hears.
    // Remote mode is unchanged in effect: the remote hub runs both against its
    // own DB, and running them here would sync into a local DB nobody reads.

    initAutoUpdater()
    logBoot('auto-updater initialized')

    // Configure webview session for WebAuthn/passkey support
    const browserSession = session.fromPartition('persist:browser-tabs')

    // Strip Electron/app name from user-agent so sites (Figma, etc.) don't detect
    // Electron and redirect to their desktop app instead of serving the web version.
    const rawUa = browserSession.getUserAgent()
    _chromeUa = rawUa.replace(/\s*Electron\/\S+/i, '').replace(/\s*slayzone\/\S+/i, '')
    _chromiumVersion = rawUa.match(/Chrome\/(\d+)/)?.[1] || '142'
    browserSession.setUserAgent(_chromeUa)

    // Serve local files via slz-file:// (Chromium blocks file:// in webviews and cross-origin renderers)
    const userHome = homedir()
    const slzFileHandler = async (request: Request) => {
      // URLs are constructed via @slayzone/platform's toSlzFileUrl, which
      // fills the authority slot with SLZ_FILE_HOST so Chromium's standard-URL
      // canonicalizer can't move the first path segment into the host
      // (lowercasing + Unicode-mangling it).
      const parsed = new URL(request.url)
      if (parsed.hostname !== SLZ_FILE_HOST) {
        return new Response('Forbidden', { status: 403 })
      }
      const filePath = normalize(decodeURIComponent(parsed.pathname))

      // Block path traversal outside user home directory.
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
        '.html': 'text/html',
        '.htm': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.avif': 'image/avif',
        '.bmp': 'image/bmp',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.pdf': 'application/pdf',
        '.xml': 'application/xml',
        '.txt': 'text/plain'
      }
      try {
        const data = await fsp.readFile(filePath)
        return new Response(data, {
          headers: {
            'content-type':
              mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-cache'
          }
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
    webPanelSession.registerPreloadScript({
      type: 'frame',
      filePath: webviewPreload,
      id: 'webview-preload-wp'
    })

    // Strawberry-style: strip Electron from UA header on every request (belt-and-suspenders
    // alongside session.setUserAgent). No Sec-CH-UA override — let Chromium send native brands.
    const stripElectronFromHeaders = (
      details: Electron.OnBeforeSendHeadersListenerDetails,
      cb: (resp: Electron.BeforeSendResponse) => void
    ) => {
      const uaKey = Object.keys(details.requestHeaders).find(
        (k) => k.toLowerCase() === 'user-agent'
      )
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
        callback({ redirectURL: fileUrlToSlzFileUrl(details.url) })
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

    // Emit the renderer Content-Security-Policy as a response header so it can
    // name the dynamic in-process tRPC WS port exactly (a static meta tag
    // can't). Registered before any window loads — createWindow() runs at the
    // end of whenReady — so every app document is covered.
    // The connect-src origin is mode-aware: local = the in-process WS port,
    // remote = the exact configured ws(s) origin (never the scheme-wide floor).
    attachRendererCsp(
      session.defaultSession,
      async () => {
        if (isRemoteMode) {
          const url = bootConfig.remote_server_url
          return url ? new URL(url).origin : ''
        }
        // Local cutover (slice 9): the renderer connects to the side-car on a
        // loopback port that can change across respawns. A loopback port-wildcard
        // is safe (only local processes) and survives a respawn-on-new-port.
        return 'ws://127.0.0.1:*'
      },
      is.dev
    )

    // Multi-hub: install the wss cert-pin verify proc on the renderer session.
    // Only pinned remote-hub hosts are enforced; every other host defers to
    // Chromium (empty pin map when single-hub → fully inert). The pin map is
    // seeded on each app:get-hub-registry call (renderer fetches it at boot).
    installHubCertPinning(session.defaultSession)
    try {
      const cfg = readBootConfig(getClientStateRoot(), getLegacyClientStateRoot())
      setPinnedHubs(resolveHubRegistry(cfg).filter((h) => h.kind === 'remote'))
    } catch {
      /* no registry yet — seeded lazily by app:get-hub-registry */
    }

    // Block external app protocol launches from webviews by registering no-op handlers.
    // External protocol URLs (figma://, slack://, etc.) bypass will-navigate entirely —
    // Chromium passes them straight to the OS. Registering the scheme in the session
    // routes them through our handler instead, returning 204 so the webview stays put.
    const blockProtocol = () =>
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
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
      allowUnpackedExtensions: true
    })
    logBoot('chrome-web-store install done')

    // Initialize Chrome extension API support for the browser panel session.
    const chromeExtensions = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: browserSession
    })
    ElectronChromeExtensions.handleCRXProtocol(browserSession)
    browserViewManager.setChromeExtensions(chromeExtensions)

    // When an extension popup is created (e.g. 1Password vault), add it to the main window
    chromeExtensions.on(
      'browser-action-popup-created',
      (popup: { browserWindow: Electron.BrowserWindow }) => {
        if (popup.browserWindow && mainWindow && !mainWindow.isDestroyed()) {
          popup.browserWindow.setParentWindow(mainWindow)
        }
      }
    )

    // Extension persistence — save/restore imported extension paths
    // (installChromeWebStore handles its own extensions, but we also support
    // importing from other browsers via loadExtension)
    const extensionsJsonPath = join(app.getPath('userData'), 'browser-extensions.json')
    const saveExtensionPaths = () => {
      try {
        const exts = browserSession.getAllExtensions().map((e) => e.path)
        fsp.writeFile(extensionsJsonPath, JSON.stringify(exts))
      } catch {
        /* best effort */
      }
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
      } catch {
        /* no saved extensions or file doesn't exist */
      }
    }
    void loadSavedExtensions()

    // Shared Chrome-extension ops — single impl behind BOTH the `browser:*` IPC
    // handlers and the tRPC `app.browser.*` extension procedures (coexistence
    // until slice 5). Captured by the setAppDeps browser closures above.
    const browserExtensionOps = {
      getExtensions: () =>
        browserSession.getAllExtensions().map((ext) => ({
          id: ext.id,
          name: ext.name,
          version: ext.manifest.version,
          manifestVersion:
            typeof ext.manifest.manifest_version === 'number'
              ? ext.manifest.manifest_version
              : undefined,
          icon: ext.manifest.icons
            ? `crx://extension-icon/${ext.id}/${Object.values(ext.manifest.icons).pop()}`
            : undefined
        })),
      loadExtension: async () => {
        if (!mainWindow) return null
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory'],
          title: 'Select Chrome Extension Directory'
        })
        if (result.canceled || !result.filePaths[0]) return null
        try {
          const ext = await browserSession.loadExtension(result.filePaths[0])
          saveExtensionPaths()
          return { id: ext.id, name: ext.name }
        } catch (err) {
          return { error: String(err) }
        }
      },
      removeExtension: (extensionId: string) => {
        browserSession.removeExtension(extensionId)
        saveExtensionPaths()
      },
      discoverBrowserExtensions: async () => {
        const appSupport = join(homedir(), 'Library', 'Application Support')
        const knownBrowsers = [
          { name: 'Chrome', dir: 'Google/Chrome/Default/Extensions' },
          { name: 'Arc', dir: 'Arc/User Data/Default/Extensions' },
          { name: 'Brave', dir: 'BraveSoftware/Brave-Browser/Default/Extensions' },
          { name: 'Edge', dir: 'Microsoft Edge/Default/Extensions' },
          { name: 'Chromium', dir: 'Chromium/Default/Extensions' },
          { name: 'Vivaldi', dir: 'Vivaldi/Default/Extensions' }
        ]
        const alreadyLoaded = new Set(browserSession.getAllExtensions().map((e) => e.id))
        const results: {
          name: string
          extensions: {
            id: string
            name: string
            version: string
            path: string
            alreadyImported: boolean
            manifestVersion?: number
          }[]
        }[] = []

        for (const browser of knownBrowsers) {
          const extDir = join(appSupport, browser.dir)
          let entries: string[]
          try {
            entries = await fsp.readdir(extDir)
          } catch {
            continue
          }

          const extensions: (typeof results)[0]['extensions'] = []
          for (const id of entries) {
            if (id === 'Temp' || id.startsWith('.')) continue
            const idDir = join(extDir, id)
            let versions: string[]
            try {
              versions = await fsp.readdir(idDir)
            } catch {
              continue
            }
            const ver = versions.sort().pop()
            if (!ver) continue
            const extPath = join(idDir, ver)
            try {
              const manifest = JSON.parse(
                await fsp.readFile(join(extPath, 'manifest.json'), 'utf-8')
              )
              let name: string = manifest.name || id
              if (name.startsWith('__MSG_')) {
                const key = name.slice(6, -2)
                for (const lang of ['en', 'en_US', 'en_GB']) {
                  try {
                    const msgs = JSON.parse(
                      await fsp.readFile(join(extPath, '_locales', lang, 'messages.json'), 'utf-8')
                    )
                    if (msgs[key]?.message) {
                      name = msgs[key].message
                      break
                    }
                  } catch {
                    /* try next lang */
                  }
                }
              }
              extensions.push({
                id,
                name,
                version: manifest.version || '?',
                path: extPath,
                alreadyImported: alreadyLoaded.has(id),
                manifestVersion:
                  typeof manifest.manifest_version === 'number'
                    ? manifest.manifest_version
                    : undefined
              })
            } catch {
              /* skip unreadable extensions */
            }
          }
          if (extensions.length > 0) {
            results.push({ name: browser.name, extensions })
          }
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
      activateExtension: (extensionId: string) => {
        // Trigger the extension's browser action by accessing the library's internal API.
        // The public API doesn't expose activate(), so we reach into the context's router.
        try {
          const ext = browserSession.getExtension(extensionId)
          if (!ext) return false
          const activeWc = browserViewManager.getActiveWebContents()
          if (!activeWc) return false
          // Access internal browser action API through the context
          const api = (chromeExtensions as any).api
          if (api?.browserAction?.activate) {
            api.browserAction.activate({ type: 'click' }, { extensionId, tabId: activeWc.id })
            return true
          }
          // Fallback: invoke via the internal handle system
          const ctx = (chromeExtensions as any).ctx
          if (ctx?.router) {
            ctx.router.invoke(activeWc, 'browserAction.activate', {
              eventType: 'click',
              extensionId
            })
            return true
          }
          return false
        } catch (err) {
          console.warn('[browser:activate-extension] Failed:', err)
          return false
        }
      }
    }
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

    // Legacy renderer IPC handles are kept only for Playwright's __testInvoke
    // bridge while tests finish moving to tRPC. Production renderer transport is
    // bootstrap IPC + tRPC over WebSocket.
    if (isPlaywright) {
      ipcMain.handle(
        'shell:open-external',
        (
          _event,
          url: string,
          options?: {
            blockDesktopHandoff?: boolean
            desktopHandoff?: DesktopHandoffPolicy
          }
        ) => shellOpenExternal(url, options)
      )

      ipcMain.handle('shell:open-path', (_event, absPath: string) => shellOpenPath(absPath))

      ipcMain.handle(
        'auth:github-system-sign-in',
        (_event, input: { convexUrl: string; redirectTo: string }) => githubSystemSignIn(input)
      )
    }

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

    if (isPlaywright) {
      ipcMain.handle('app:getVersion', () => app.getVersion())
      // Post-cutover the renderer's tRPC backend is the side-car (the in-process
      // server is retired). Report the side-car port; remote mode has no local port.
      ipcMain.handle('app:get-trpc-port', async () => {
        if (isRemoteMode) return 0
        try {
          const handle = await sidecarHandlePromise
          await handle.waitForReady()
          return handle.getPort() ?? 0
        } catch {
          return 0
        }
      })
    }
    ipcMain.handle('app:get-window-id', (event) => taskWindowsOps.getWindowId(event.sender.id))
    // Bootstrap IPCs for the server-mode toggle (slice 7) — the last new IPC
    // before slice 8 drops the legacy bridge. These three CANNOT be tRPC: they
    // decide which server the tRPC client connects to in the first place.
    //
    // Returns the WS URL the renderer should connect to + the active mode.
    // Local: waits for the embedded server's port (up to 5s). Remote: the
    // pre-boot configured URL (may be '' — renderer shows RemoteConfigScreen).
    ipcMain.handle('app:get-server-url', async () => {
      if (isRemoteMode) {
        return { mode: 'remote' as const, url: bootConfig.remote_server_url ?? '' }
      }
      // Local cutover (slice 9): the renderer connects to the SIDE-CAR. Await the
      // supervisor handle (the spawn setImmediate may not have run yet), then its
      // first ready (rejects on permanent failure → empty url → renderer surfaces
      // the embedded-server-failed toast).
      try {
        const handle = await sidecarHandlePromise
        await handle.waitForReady()
        const port = handle.getPort()
        return { mode: 'local' as const, url: port ? `ws://127.0.0.1:${port}/trpc` : '' }
      } catch {
        return { mode: 'local' as const, url: '' }
      }
    })
    // Full process restart — the embedded-server start/skip decision happens at
    // boot, so a Local↔Remote switch needs a relaunch. No-op under Playwright:
    // the harness owns the process; a detached relaunch would orphan the run
    // (specs assert the boot-config file + cover remote boot via a fresh launch).
    ipcMain.handle('app:relaunch', () => {
      if (isPlaywright) {
        logBoot('app:relaunch skipped (PLAYWRIGHT)')
        return
      }
      app.relaunch()
      app.exit(0)
    })
    // Cycle the embedded side-car in place (same sticky port — the renderer's
    // WS reconnects). Local mode only: in remote mode the backend runs
    // elsewhere and the supervisor was never started (its handle promise never
    // resolves, so awaiting it would hang forever).
    ipcMain.handle('app:restart-sidecar', async () => {
      if (isRemoteMode) {
        return { ok: false as const, error: 'Remote mode — no embedded server to restart' }
      }
      try {
        const handle = await sidecarHandlePromise
        await handle.restart()
        await handle.waitForReady()
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    })
    // Cycle the co-located runner. Every agent pty on this machine is a direct
    // child of it, so this is a heavier hammer than the side-car restart — but it
    // is the ONLY recovery from the supervisor's dead ends (needs-re-enrollment,
    // exhausted backoff, and the boot-time "join-token mint failed → never
    // spawned" case). All three previously required relaunching the app, while
    // nothing on the machine could execute.
    ipcMain.handle('app:restart-local-runner', async () => {
      if (isRemoteMode) {
        return { ok: false as const, error: 'Remote mode — no local runner on this machine' }
      }
      try {
        if (localRunnerHandle) {
          await localRunnerHandle.restart()
        } else {
          // Never spawned (or its auto-enroll is still retrying) — the recovery
          // is the full mint-then-spawn path, not a cycle. Single-flight, so a
          // click during boot's attempt joins it rather than racing it.
          await ensureLocalRunnerStarted()
          if (!localRunnerHandle) {
            return {
              ok: false as const,
              error:
                'Could not enroll a local runner — the hub refused to mint a join token. See Settings → Diagnostics.'
            }
          }
        }
        recordDiagnosticEvent({
          level: 'info',
          source: 'main',
          event: 'local_runner.manual_restart',
          message:
            'Local runner restarted from Settings → Runners. Every agent terminal on this ' +
            'machine was stopped with it.',
          payload: { pid: localRunnerHandle.getPid() }
        })
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    })
    // Reads the pre-boot config the renderer needs for settings toggles that
    // aren't backed by the settings DB (multi-hub — see RunnersSettingsTab). The
    // in-memory `bootConfig` was read once at boot; re-read from disk so a save
    // made since boot is reflected. `server_mode`/url are already exposed via
    // `app:get-server-url`; this surfaces `multi_hub` as a plain boolean.
    ipcMain.handle('app:get-boot-config', () => {
      const cfg = readBootConfig(getClientStateRoot(), getLegacyClientStateRoot())
      return { multiHub: cfg.multi_hub === true }
    })
    // Resolved multi-hub registry the renderer's FederationProvider connects to.
    // Single source of truth for "which hubs exist": synthesized purely from the
    // pre-boot config (resolveHubRegistry), then the LOCAL hub's runtime ws url
    // is injected here from the live sidecar handle (the config can't know the
    // sticky port). With multi_hub off this returns exactly today's single
    // effective hub, so the renderer's HubScope('local') stays byte-identical.
    ipcMain.handle('app:get-hub-registry', async () => {
      const cfg = readBootConfig(getClientStateRoot(), getLegacyClientStateRoot())
      const hubs = resolveHubRegistry(cfg)
      const defaultHubId = resolveDefaultHubId(cfg, hubs)
      // Inject the local hub's live ws url (only when a local hub is listed —
      // legacy remote mode has none and never spawned the sidecar).
      const local = hubs.find((h) => h.id === LOCAL_HUB_ID)
      if (local && !isRemoteMode) {
        try {
          const handle = await sidecarHandlePromise
          await handle.waitForReady()
          const port = handle.getPort()
          if (port) local.url = `ws://127.0.0.1:${port}/trpc`
        } catch {
          /* sidecar failed — leave url absent; renderer surfaces the toast */
        }
      }
      // Multi-hub: refresh the main-process wss cert-pin map from the registry
      // (remote hubs with a known fingerprint). No-op / empty when single-hub.
      setPinnedHubs(hubs.filter((h) => h.kind === 'remote'))
      return { hubs, defaultHubId }
    })
    // Per-hub bearer tokens (safeStorage-encrypted, main-only). The renderer
    // fetches them to open authed connections; writes come from the enroll/login
    // flow. Empty when no authed hubs are configured.
    ipcMain.handle('app:get-hub-tokens', () => getAllHubTokens(getClientStateRoot(), getLegacyClientStateRoot()))
    ipcMain.handle(
      'app:set-hub-token',
      (_event, payload: { hubId: string; token: string }) => {
        setHubToken(getClientStateRoot(), payload.hubId, payload.token)
        return { ok: true as const }
      }
    )
    // Sign in to a remote hub (email+password → bearer). Runs main-side (CSP +
    // cert-pin), then persists the token for that hub. Returns ok/error to the UI.
    ipcMain.handle(
      'app:hub-login',
      async (_event, payload: { hubId: string; url: string; email: string; password: string }) => {
        const result = await hubLogin(payload.url, payload.email, payload.password)
        if (result.ok) {
          try {
            setHubToken(getClientStateRoot(), payload.hubId, result.token)
          } catch (err) {
            return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
          }
          return { ok: true as const }
        }
        return { ok: false as const, error: result.error }
      }
    )
    // Writes the pre-boot config file. Throws on an unnormalizable URL.
    ipcMain.handle(
      'app:set-boot-settings',
      (
        _event,
        payload: {
          server_mode?: 'local' | 'remote'
          remote_server_url?: string
          multi_hub?: boolean
          hubs?: HubEntry[]
          default_hub_id?: string
        }
      ) => {
        // legacy dir passed so the FIRST write after the relocation merges over
        // the old file rather than resetting unset fields to their defaults.
        writeBootSettings(
          getClientStateRoot(),
          {
            server_mode: payload?.server_mode,
            remote_server_url: payload?.remote_server_url,
            multi_hub: payload?.multi_hub,
            hubs: payload?.hubs,
            default_hub_id: payload?.default_hub_id
          },
          getLegacyClientStateRoot()
        )
        return { ok: true as const }
      }
    )
    // Main-side GET /health probe — the renderer can't fetch it itself (CSP
    // floor only allows ws(s) connects; /health sets no CORS headers), and the
    // RemoteConfigScreen needs it before any tRPC client exists.
    ipcMain.handle('app:probe-server-health', (_event, rawUrl: string) =>
      probeRemoteHealth(typeof rawUrl === 'string' ? rawUrl : '')
    )
    if (isPlaywright) {
      ipcMain.handle('app:get-sidecar-status', () => getSidecarStatusSnapshot())
      ipcMain.handle('app:reveal-sidecar-log', () => revealSidecarLogInFinder())
      ipcMain.handle('app:is-tests-panel-enabled', () => isLabEnabled('labs_tests_panel'))
      ipcMain.on('app:is-tests-panel-enabled-sync', (event) => {
        event.returnValue = isLabEnabled('labs_tests_panel')
      })
      ipcMain.handle('app:is-loop-mode-enabled', () => isLabEnabled('labs_loop_mode'))
      ipcMain.on('app:is-loop-mode-enabled-sync', (event) => {
        event.returnValue = isLabEnabled('labs_loop_mode')
      })
      ipcMain.handle('app:get-protocol-client-status', () => protocolClientStatus)
      ipcMain.handle('app:get-zoom-factor', () => mainWindow?.webContents.zoomFactor ?? 1)
      ipcMain.handle('app:adjust-zoom', (_event, command: AppZoomCommand) => applyAppZoom(command))
      ipcMain.handle('app:focus-renderer', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed() || !win.isFocused()) return
        event.sender.focus()
      })
      ipcMain.handle('app:restart-for-update', () => restartForUpdate())
      ipcMain.handle('app:check-for-updates', () => checkForUpdates())
      ipcMain.handle('app:cli-status', () => checkCliInstalled())
      ipcMain.handle('app:install-cli', () => installCli(getCliSrc()))

      ipcMain.handle('window:close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win) win.close()
      })

      ipcMain.handle(
        'window:set-traffic-light-position',
        (event, pos: { x: number; y: number } | null) => {
          if (process.platform !== 'darwin') return
          const win = BrowserWindow.fromWebContents(event.sender)
          if (!win) return
          win.setWindowButtonPosition(pos ?? { x: 10, y: 12 })
        }
      )

      ipcMain.handle('window:set-window-button-visibility', (event, visible: boolean) => {
        if (process.platform !== 'darwin') return
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return
        win.setWindowButtonVisibility(visible)
      })

      ipcMain.handle(
        'dialog:showOpenDialog',
        async (
          _,
          options: {
            title?: string
            defaultPath?: string
            properties?: Array<
              | 'openFile'
              | 'openDirectory'
              | 'multiSelections'
              | 'showHiddenFiles'
              | 'createDirectory'
              | 'promptToCreate'
              | 'noResolveAliases'
              | 'treatPackageAsDirectory'
              | 'dontAddToRecent'
            >
            filters?: Array<{ name: string; extensions: string[] }>
          }
        ) => dialog.showOpenDialog(options)
      )

      ipcMain.handle(
        'webview:register-browser-tab',
        (_, taskId: string, tabId: string, webContentsId: number) => {
          registerBrowserTab(taskId, tabId, webContentsId)
        }
      )
      ipcMain.handle('webview:unregister-browser-tab', (_, taskId: string, tabId: string) => {
        unregisterBrowserTab(taskId, tabId)
      })
      ipcMain.handle(
        'webview:set-active-browser-tab',
        (_, taskId: string, tabId: string | null) => {
          setActiveBrowserTab(taskId, tabId)
        }
      )
      ipcMain.handle('webview:register-shortcuts', (_event, webviewId: number) =>
        webviewOps.registerShortcuts(webviewId)
      )
      ipcMain.handle(
        'webview:set-keyboard-passthrough',
        (_event, webviewId: number, enabled: boolean) =>
          webviewOps.setKeyboardPassthrough(webviewId, enabled)
      )
      ipcMain.handle(
        'webview:set-desktop-handoff-policy',
        (_, webviewId: number, policy: DesktopHandoffPolicy | null) =>
          webviewOps.setDesktopHandoffPolicy(webviewId, policy)
      )
      ipcMain.handle(
        'webview:open-devtools-bottom',
        (_, webviewId: number, options?: { probe?: boolean }) =>
          webviewOps.openDevToolsBottom(webviewId, options)
      )
      ipcMain.handle('webview:close-devtools', (_, webviewId: number) =>
        webviewOps.closeDevTools(webviewId)
      )
      ipcMain.handle('webview:open-devtools-detached', (_, webviewId: number) =>
        webviewOps.openDevToolsDetached(webviewId)
      )
      ipcMain.handle('webview:is-devtools-opened', (_, webviewId: number) =>
        webviewOps.isDevToolsOpened(webviewId)
      )
      ipcMain.handle(
        'webview:enable-device-emulation',
        (
          _,
          webviewId: number,
          params: {
            screenSize: { width: number; height: number }
            viewSize: { width: number; height: number }
            deviceScaleFactor: number
            screenPosition: 'mobile' | 'desktop'
            userAgent?: string
          }
        ) => webviewOps.enableDeviceEmulation(webviewId, params)
      )
      ipcMain.handle('webview:disable-device-emulation', (_, webviewId: number) =>
        webviewOps.disableDeviceEmulation(webviewId)
      )
    }

    // --- Browser View Manager (WebContentsView) ---
    // Wire handoff policy mirror so main-process hardening listeners see WCV policies
    browserViewManager.setHandoffPolicyChangeCallback((wcId, policy) => {
      if (policy) {
        webviewDesktopHandoffPolicy.set(wcId, policy)
      } else {
        webviewDesktopHandoffPolicy.delete(wcId)
      }
    })

    if (isPlaywright) {
      ipcMain.handle('browser:create-view', (_, opts: CreateViewOpts) =>
        browserViewManager.createView(opts)
      )
      ipcMain.handle('browser:reparent-to-current-window', (event, viewId: string) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) return { ok: false }
        const ok = browserViewManager.reparentView(viewId, win)
        return { ok }
      })
      ipcMain.handle('browser:destroy-view', (_, viewId: string) =>
        browserViewManager.destroyView(viewId)
      )
      ipcMain.handle('browser:destroy-all-for-task', (_, taskId: string) =>
        browserViewManager.destroyAllForTask(taskId)
      )
      ipcMain.handle('browser:set-bounds', (_, viewId: string, bounds: ViewBounds) =>
        browserViewManager.setBounds(viewId, bounds)
      )
      ipcMain.handle('browser:set-visible', (_, viewId: string, visible: boolean) =>
        browserViewManager.setVisible(viewId, visible)
      )
      ipcMain.handle('browser:set-locked', (_, viewId: string, locked: boolean) =>
        browserViewManager.setLocked(viewId, locked)
      )
      ipcMain.handle('browser:hide-all', () => browserViewManager.hideAll())
      ipcMain.handle('browser:show-all', () => browserViewManager.showAll())
      ipcMain.handle(
        'browser:set-handoff-policy',
        (_, viewId: string, policy: DesktopHandoffPolicy | null) =>
          browserViewManager.setHandoffPolicy(viewId, policy)
      )
      ipcMain.handle('browser:__test-emit-shortcut', (_, payload: unknown) =>
        browserViewEvents.emit('shortcut', payload)
      )
      ipcMain.handle('browser:navigate', (_, viewId: string, url: string) =>
        browserViewManager.navigate(viewId, url)
      )
      ipcMain.handle('browser:go-back', (_, viewId: string) => browserViewManager.goBack(viewId))
      ipcMain.handle('browser:go-forward', (_, viewId: string) =>
        browserViewManager.goForward(viewId)
      )
      ipcMain.handle('browser:reload', (_, viewId: string, ignoreCache?: boolean) =>
        browserViewManager.reload(viewId, ignoreCache)
      )
      ipcMain.handle('browser:stop', (_, viewId: string) => browserViewManager.stop(viewId))
      ipcMain.handle('browser:execute-js', (_, viewId: string, code: string) =>
        browserViewManager.executeJs(viewId, code)
      )
      ipcMain.handle('browser:insert-css', (_, viewId: string, css: string) =>
        browserViewManager.insertCss(viewId, css)
      )
      ipcMain.handle('browser:remove-css', (_, viewId: string, key: string) =>
        browserViewManager.removeCss(viewId, key)
      )
      ipcMain.handle('browser:set-zoom', (_, viewId: string, factor: number) =>
        browserViewManager.setZoom(viewId, factor)
      )
      ipcMain.handle('browser:focus', (_, viewId: string) => browserViewManager.focus(viewId))
      ipcMain.handle(
        'browser:find-in-page',
        (
          _,
          viewId: string,
          text: string,
          options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
        ) => browserViewManager.findInPage(viewId, text, options)
      )
      ipcMain.handle(
        'browser:stop-find-in-page',
        (_, viewId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection') =>
          browserViewManager.stopFindInPage(viewId, action)
      )
      ipcMain.handle('browser:set-keyboard-passthrough', (_, viewId: string, enabled: boolean) =>
        browserViewManager.setKeyboardPassthrough(viewId, enabled)
      )
      ipcMain.handle(
        'browser:send-input-event',
        (_, viewId: string, input: Electron.KeyboardInputEvent) =>
          browserViewManager.sendInputEvent(viewId, input)
      )
    }
    ipcMain.on(
      'browser:request-create-task-from-link',
      (event, payload: { url?: unknown; linkText?: unknown }) => {
        const url = typeof payload?.url === 'string' ? payload.url : ''
        if (!/^https?:\/\//i.test(url)) return
        const linkText = typeof payload?.linkText === 'string' ? payload.linkText : undefined
        browserViewManager.emitCreateTaskFromLinkForWebContents(event.sender.id, {
          url,
          linkText,
          source: 'modified-link-click'
        })
      }
    )
    ipcMain.on('browser:request-open-link-externally', (_event, payload: { url?: unknown }) => {
      const url = typeof payload?.url === 'string' ? payload.url : ''
      if (!/^https?:\/\//i.test(url)) return
      void shell.openExternal(url)
    })

    if (isPlaywright) {
      ipcMain.handle(
        'browser:open-devtools',
        (_, viewId: string, mode: 'bottom' | 'right' | 'undocked' | 'detach') =>
          browserViewManager.openDevTools(viewId, mode)
      )
      ipcMain.handle('browser:close-devtools', (_, viewId: string) =>
        browserViewManager.closeDevTools(viewId)
      )
      ipcMain.handle('browser:is-devtools-open', (_, viewId: string) =>
        browserViewManager.isDevToolsOpen(viewId)
      )
      ipcMain.handle('browser:get-extensions', () => browserExtensionOps.getExtensions())
      ipcMain.handle('browser:load-extension', () => browserExtensionOps.loadExtension())
      ipcMain.handle('browser:remove-extension', (_, extensionId: string) =>
        browserExtensionOps.removeExtension(extensionId)
      )
      ipcMain.handle('browser:discover-browser-extensions', () =>
        browserExtensionOps.discoverBrowserExtensions()
      )
      ipcMain.handle('browser:import-extension', (_, extPath: string) =>
        browserExtensionOps.importExtension(extPath)
      )
      ipcMain.handle('browser:activate-extension', (_, extensionId: string) =>
        browserExtensionOps.activateExtension(extensionId)
      )
      ipcMain.handle('browser:get-web-contents-id', (_, viewId: string) =>
        browserViewManager.getWebContentsId(viewId)
      )
      ipcMain.handle(
        'app:get-renderer-zoom-factor',
        () => mainWindow?.webContents.zoomFactor ?? null
      )
      ipcMain.handle('window:get-content-bounds', () => mainWindow?.getContentBounds() ?? null)
      ipcMain.handle('window:get-display-scale-factor', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return null
        return screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor
      })
      ipcMain.handle('browser:get-url', (_, viewId: string) => browserViewManager.getUrl(viewId))
      ipcMain.handle('browser:get-bounds', (_, viewId: string) =>
        browserViewManager.getBounds(viewId)
      )
      ipcMain.handle('browser:get-zoom-factor', (_, viewId: string) =>
        browserViewManager.getZoomFactor(viewId)
      )
      ipcMain.handle(
        'browser:test-dispatch-mouse-click',
        (_event, viewId: string, point: { x?: unknown; y?: unknown }, modifiers?: unknown) => {
          const x = typeof point?.x === 'number' ? point.x : NaN
          const y = typeof point?.y === 'number' ? point.y : NaN
          if (!Number.isFinite(x) || !Number.isFinite(y)) return false

          const normalizedModifiers = Array.isArray(modifiers)
            ? modifiers.filter(
                (modifier): modifier is 'shift' | 'control' | 'alt' | 'meta' =>
                  modifier === 'shift' ||
                  modifier === 'control' ||
                  modifier === 'alt' ||
                  modifier === 'meta'
              )
            : []

          return browserViewManager.dispatchMouseClick(viewId, { x, y }, normalizedModifiers)
        }
      )
      ipcMain.handle(
        'browser:test-dispatch-create-task-from-link',
        (_event, viewId: string, payload: { url?: unknown; linkText?: unknown }) => {
          const url = typeof payload?.url === 'string' ? payload.url : ''
          if (!/^https?:\/\//i.test(url)) return false
          const linkText = typeof payload?.linkText === 'string' ? payload.linkText : undefined
          return browserViewManager.emitCreateTaskFromLinkForView(viewId, {
            url,
            linkText,
            source: 'modified-link-click'
          })
        }
      )
      ipcMain.handle(
        'browser:test-run-link-context-menu-action',
        (
          _event,
          viewId: string,
          payload: { linkURL?: unknown; linkText?: unknown },
          action: unknown
        ) => {
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
      ipcMain.handle('browser:get-all-view-ids', () => browserViewManager.getAllViewIds())
      ipcMain.handle('browser:get-views-for-task', (_, taskId: string) =>
        browserViewManager.getViewsForTask(taskId)
      )
      ipcMain.handle('browser:list-views', () => browserViewManager.listViews())
      ipcMain.handle('browser:is-focused', (_, viewId: string) =>
        browserViewManager.isFocused(viewId)
      )
      ipcMain.handle('browser:get-actual-native-bounds', (_, viewId: string) =>
        browserViewManager.getActualNativeBounds(viewId)
      )
      ipcMain.handle('browser:is-all-hidden', () => browserViewManager.isAllHidden())
      ipcMain.handle('browser:get-view-visible', (_, viewId: string) =>
        browserViewManager.getViewVisible(viewId)
      )
      ipcMain.handle('browser:is-view-natively-visible', (_, viewId: string) =>
        browserViewManager.isViewNativelyVisible(viewId)
      )
      ipcMain.handle('browser:get-partition', (_, viewId: string) =>
        browserViewManager.getPartition(viewId)
      )
      ipcMain.handle('browser:get-native-child-view-count', () =>
        browserViewManager.getNativeChildViewCount()
      )
      ipcMain.handle('browser:is-locked', (_, viewId: string) =>
        browserViewManager.isLocked(viewId)
      )
    }

    // The process-manager runtime lives in the SIDE-CAR (composition.ts). The
    // remote-mode branch that used to init it here ran against the LOCAL database,
    // which in remote mode holds nothing — no processes to restart, so it could
    // only ever be a no-op with a connection attached. The remote hub runs its own.
    logBoot('process manager owned by the hub')

    // Reset all main-process state + DB for test isolation (Playwright only)
    if (isPlaywright) {
      ipcMain.handle('app:reset-for-test', async () => {
        // 1. Kill running processes
        killAllPtys()
        killAllChatTransports()
        stopIdleChecker()
        killAllProcesses()

        // 2. Stop timers
        if (linearSyncPoller) {
          clearInterval(linearSyncPoller)
          linearSyncPoller = null
        }
        if (discoveryPoller) {
          clearInterval(discoveryPoller)
          discoveryPoller = null
        }

        // 3. Local cutover (slice 9): KEEP the host capability + REST servers up
        // on their stable ports — the respawned side-car (step 8) reconnects to
        // them via its fixed env URLs. Stopping them here would strand the
        // restarted side-car. Remote mode: nothing was started, nothing to stop.

        // 4. Close file watchers
        closeAllWatchers()
        closeArtifactWatcher()
        closeGitWatcher()

        // 5. Clear registries + flags + browser view manager
        clearBrowserRegistry()
        resetSyncFlags()
        browserViewManager.reset()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.zoomLevel = 0
          menuEvents.emit('zoom-factor-changed', mainWindow.webContents.zoomFactor)
        }

        // 6. Clear oauth state
        oauthCallbackQueue.length = 0
        oauthCallbackWaiters.clear()

        // 7. Drop all tables + re-migrate. Runs in the SIDE-CAR, which holds the
        // connection it rebuilds; the host asks over the E2E-gated dev route.
        await devReset()

        // 7b. Seed post-onboarding baseline so tests skip the onboarding wizard.
        // `onboarding_completed` is hub-scoped (the renderer reads it over tRPC),
        // so it is seeded in the hub's database, not the client store.
        await devSqlRun(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true')"
        )
        // Client store is unaffected by the schema rebuild, but re-read anyway so
        // any test that rewrote it takes effect.
        clientSettings = readClientSettings(clientRoot)

        // 8. Restart the side-car so it re-opens the freshly-migrated DB and
        // re-warms every cache (settings, process registry, pty/chat sessions,
        // automation engine) — the renderer's data backend. The host cap/REST
        // servers stayed up (step 3), so the respawned child reconnects with the
        // same env URLs on the sticky port, and the renderer's tRPC client
        // reconnects automatically. Remote mode: no local side-car.
        if (!isRemoteMode && sidecarServerHandle) {
          await sidecarServerHandle.restart()
          await sidecarServerHandle.waitForReady()
        }

        // 9. Process manager is owned + re-inited by the side-car on restart.
        return { ok: true }
      })

      // E2E test bridges. Cheap, read-only. Gated to Playwright so they cannot
      // be invoked from a production renderer.
      ipcMain.handle('e2e:get-env', (_e, keys: string[]) => {
        if (!Array.isArray(keys)) return {}
        const out: Record<string, string | undefined> = {}
        for (const k of keys) out[k] = process.env[k]
        return out
      })
      ipcMain.handle('e2e:get-mcp-port', async () => {
        // Post-cutover the discoverable backend (CLI + agent-hooks + external
        // MCP) is the SIDE-CAR — production agents spawned by the side-car PTY
        // get its port. The host's __serverPort is only the reverse-proxy target.
        if (isRemoteMode) return (globalThis as Record<string, unknown>).__serverPort ?? null
        try {
          const handle = await sidecarHandlePromise
          await handle.waitForReady()
          return handle.getPort() ?? null
        } catch {
          return (globalThis as Record<string, unknown>).__serverPort ?? null
        }
      })
      // Spy/stub a HOST AppDeps method through the capability bridge. Post-cutover
      // the renderer's `app.*` capability calls route renderer→sidecar→bridge→host
      // getAppDeps()[method] (resolved fresh per invoke), so wrapping the host's
      // entry here records every bridged call. Replaces the old IPC-handler mocks
      // that the renderer abandoned for tRPC in slice 8. Reads at
      // `globalThis.__appDepSpies[method] = { calls, lastArgs }`. Optional
      // `fakeResult` short-circuits the real impl (deterministic/offline).
      ipcMain.handle('e2e:spy-app-dep', async (_e, method: string, fakeResult?: unknown) => {
        const mod = await import('@slayzone/transport/server')
        const deps = mod.getAppDeps() as unknown as Record<string, (...a: unknown[]) => unknown>
        const g = globalThis as Record<string, unknown>
        const spies = (g.__appDepSpies ??= {}) as Record<
          string,
          { calls: number; lastArgs: unknown[] | null }
        >
        spies[method] = { calls: 0, lastArgs: null }
        const original = deps[method]
        deps[method] = (...args: unknown[]) => {
          spies[method].calls += 1
          spies[method].lastArgs = args
          return fakeResult !== undefined ? fakeResult : original?.(...args)
        }
        return { ok: true }
      })
    }

    createWindow()
    logBoot('windows created')
    if (mainWindow) setProcessManagerWindow(mainWindow)

    recordDiagnosticEvent({
      level: 'info',
      source: 'main',
      event: 'app.boot.ready',
      payload: { version: app.getVersion() }
    })

    // PTY stats poller — lazy start/stop via session lifecycle
    const ptyStatsPoller = createStatsPoller(
      () => getPtyPids(),
      (stats) => {
        ptyEvents.emit('stats', stats) // tRPC pty.onStats source
      }
    )
    onSessionChange(() => ptyStatsPoller.ensureStarted())

    if (isPlaywright) {
      ipcMain.handle(
        'processes:create',
        (
          _event,
          projectId: string | null,
          taskId: string | null,
          label: string,
          command: string,
          cwd: string,
          autoRestart: boolean
        ) => createProcess(projectId, taskId, label, command, cwd, autoRestart)
      )
      ipcMain.handle(
        'processes:spawn',
        (
          _event,
          projectId: string | null,
          taskId: string | null,
          label: string,
          command: string,
          cwd: string,
          autoRestart: boolean
        ) => spawnProcess(projectId, taskId, label, command, cwd, autoRestart)
      )
      ipcMain.handle(
        'processes:update',
        (_event, processId: string, updates: Parameters<typeof updateProcess>[1]) =>
          updateProcess(processId, updates)
      )
      ipcMain.handle('processes:stop', (_event, processId: string) => stopProcess(processId))
      ipcMain.handle('processes:kill', (_event, processId: string) => killProcess(processId))
      ipcMain.handle('processes:restart', (_event, processId: string) =>
        restartProcess(processId)
      )
      ipcMain.handle(
        'processes:listForTask',
        (_event, taskId: string | null, projectId: string | null) =>
          listForTask(taskId, projectId)
      )
      ipcMain.handle('processes:listAll', () => listAllProcesses())
      ipcMain.handle('processes:killTask', (_event, taskId: string) => {
        killTaskProcesses(taskId)
      })
    }

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else presentWindow(mainWindow)
    })
  })
  .catch((error) => {
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
const _uaPlatform =
  process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
const _uaPlatformVersion =
  process.platform === 'darwin' ? '14.0.0' : process.platform === 'win32' ? '10.0.0' : '6.0.0'
const isBlockedScheme = (url: string) => isBlockedExternalProtocolUrl(url)
const webviewDesktopHandoffPolicy = new Map<number, DesktopHandoffPolicy>()
const webviewDesktopHandoffPolicyCleanupRegistered = new Set<number>()

// Webview shortcut state lifted to module scope so webviewOps (and the
// setAppDeps webview closures) can own it across both transports.
const registeredWebviews = new Set<number>()
const keyboardPassthroughWebviews = new Set<number>()
// tRPC shortcut stream for browser-tab keyboard handling.
const webviewEvents = new EventEmitter() as EventEmitter & {
  on(
    event: 'shortcut',
    listener: (payload: { webviewId: number; key: string; shift: boolean }) => void
  ): EventEmitter
  off(event: string, listener: (...args: unknown[]) => void): EventEmitter
}

// Shared webview ops — single impl behind BOTH the `webview:*` IPC handlers and
// the tRPC `app.webview.*` procedures (coexistence until slice 5). Grows across
// P19k (devtools) + P19m (shortcuts/emulation); captured by the setAppDeps
// webview closures above (run only after this module-scope init).
const webviewOps = {
  closeDevTools: (webviewId: number) => {
    const wc = webContents.fromId(webviewId)
    if (!wc || wc.isDestroyed()) return false
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    return true
  },
  isDevToolsOpened: (webviewId: number) => {
    const wc = webContents.fromId(webviewId)
    if (!wc || wc.isDestroyed()) return false
    return wc.isDevToolsOpened()
  },
  disableDeviceEmulation: (webviewId: number) => {
    const wc = webContents.fromId(webviewId)
    if (!wc) return false
    wc.disableDeviceEmulation()
    wc.setUserAgent(_chromeUa)
    return true
  },
  // tRPC subscribers receive browser-tab shortcuts via webviewEvents.
  registerShortcuts: (webviewId: number) => {
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
        const key = input.key.toLowerCase()
        const shift = Boolean(input.shift)
        webviewEvents.emit('shortcut', { webviewId, key, shift }) // tRPC app.webview.onShortcut
      }
    })
    wc.on('destroyed', () => {
      registeredWebviews.delete(webviewId)
      keyboardPassthroughWebviews.delete(webviewId)
    })
  },
  setKeyboardPassthrough: (webviewId: number, enabled: boolean) => {
    if (enabled) keyboardPassthroughWebviews.add(webviewId)
    else keyboardPassthroughWebviews.delete(webviewId)
  },
  setDesktopHandoffPolicy: (webviewId: number, policy: DesktopHandoffPolicy | null) => {
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
  },
  openDevToolsBottom: async (webviewId: number, options?: { probe?: boolean }) => {
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
    const variants: Array<{ mode: 'bottom' | 'right' | 'undocked' | 'detach'; activate: boolean }> =
      [
        { mode: 'bottom', activate: false },
        { mode: 'bottom', activate: true },
        { mode: 'right', activate: false },
        { mode: 'right', activate: true },
        { mode: 'undocked', activate: false },
        { mode: 'undocked', activate: true },
        { mode: 'detach', activate: false },
        { mode: 'detach', activate: true }
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
        console.log('[webview:open-devtools-bottom] selected variant', {
          webviewId,
          mode: variant.mode,
          activate: variant.activate,
          openedEvent,
          elapsedMs
        })
        return true
      }
    }
    if (options?.probe) {
      return { ok: true, webviewId, type: wc.getType(), attempts }
    }
    console.warn('[webview:open-devtools-bottom] failed to open', { webviewId, attempts })
    return wc.isDevToolsOpened()
  },
  openDevToolsDetached: async (webviewId: number) => {
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
      console.warn('[webview:open-devtools-detached] failed', {
        webviewId,
        err: err instanceof Error ? err.message : String(err)
      })
      return false
    }
  },
  enableDeviceEmulation: (
    webviewId: number,
    params: {
      screenSize: { width: number; height: number }
      viewSize: { width: number; height: number }
      deviceScaleFactor: number
      screenPosition: 'mobile' | 'desktop'
      userAgent?: string
    }
  ) => {
    const wc = webContents.fromId(webviewId)
    if (!wc) return false
    wc.enableDeviceEmulation({
      screenPosition: params.screenPosition,
      screenSize: params.screenSize,
      viewSize: params.viewSize,
      deviceScaleFactor: params.deviceScaleFactor,
      viewPosition: { x: 0, y: 0 },
      scale: 1
    })
    if (params.userAgent) wc.setUserAgent(params.userAgent)
    return true
  }
}

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

  const isWebviewOrHasPolicy = () =>
    wc.getType() === 'webview' || webviewDesktopHandoffPolicy.has(wc.id)

  // Handoff hardening: legacy webviews + WCV views with policies.
  // setWindowOpenHandler for legacy webviews only — WCV views get their handler from the manager.
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler((details) => {
      if (webviewDesktopHandoffPolicy.has(wc.id)) return { action: 'deny' }
      if (details.disposition === 'new-window' && /^https?:\/\//i.test(details.url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true
          }
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
            { brand: 'Not_A Brand', version: '8' }
          ],
          fullVersionList: [
            { brand: 'Google Chrome', version: `${_chromiumVersion}.0.0.0` },
            { brand: 'Chromium', version: `${_chromiumVersion}.0.0.0` },
            { brand: 'Not_A Brand', version: '8.0.0.0' }
          ],
          mobile: false,
          platform: _uaPlatform,
          platformVersion: _uaPlatformVersion,
          architecture: process.arch === 'arm64' ? 'arm' : 'x86',
          model: '',
          bitness: '64'
        }
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

app.on('before-quit', (event) => {
  if (quitDrainComplete) return
  event.preventDefault()
  void shutdownSubprocessesForQuit().finally(() => {
    quitDrainComplete = true
    app.quit()
  })
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
  bridgeCleanup?.()
  sidecarCleanup?.()
  localRunnerCleanup?.()
  // Record completion BEFORE closing diagnostics DB; a row written here is the last
  // event of the session and proves the chain ran. stopDiagnostics() can clear timers
  // safely after.
  recordDiagnosticEvent({
    level: 'info',
    source: 'main',
    event: 'app.will-quit.complete',
    payload: { version: app.getVersion() }
  })
  stopDiagnostics()
  stopIdleChecker()
  closeArtifactWatcher()
  closeGitWatcher()
  closeDiagnosticsDatabase()
  // Sentinel last: presence on next boot ⇒ clean shutdown reached this line.
  // Pure fs (no DB needed), so survives any prior close failure.
  writeCleanShutdownSentinel()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
