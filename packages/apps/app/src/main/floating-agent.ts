import { BrowserWindow, ipcMain, screen, globalShortcut, app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { redirectSessionWindow, getBufferSince } from '@slayzone/terminal/main'
import { toElectronAccelerator, shortcutDefinitions } from '@slayzone/shortcuts'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/main'
import { getDatabase } from './db'
import {
  reduce,
  type State,
  type Event as FsmEvent,
  type Action,
  type Context
} from './floating-agent/state-machine'

// --- Types ---

type AnchorPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center-bottom' | 'center-left' | 'center-right'
type WidgetStyle = 'widget' | 'icon'

interface FloatingAgentConfig {
  style: WidgetStyle
  position: AnchorPosition
}

// --- Constants ---

const DEFAULT_CONFIG: FloatingAgentConfig = { style: 'widget', position: 'bottom-right' }
const COLLAPSED_WIDTH = 220
const COLLAPSED_HEIGHT = 80
const COLLAPSED_ICON_SIZE = 60
const EXPANDED_WIDTH = 360
const EXPANDED_HEIGHT_RATIO = 0.5
const EXPANDED_MIN_WIDTH = 280
const EXPANDED_MIN_HEIGHT = 200
const MARGIN = 0

// --- State machine wiring ---

let state: State = { kind: 'attached' }
let ctx: Context = { enabled: false, panelOpen: false, sessionId: null, collapsed: true }

let mainWindow: BrowserWindow | null = null
let floatingAgentWindow: BrowserWindow | null = null
let currentFloatingSession: { sessionId: string; cwd: string; mode: string } | null = null
let currentConfig: FloatingAgentConfig = DEFAULT_CONFIG
let registeredAccelerator: string | null = null
let getShortcutOverrides: () => Record<string, string | null> = () => ({})
let expandedSize: { width: number; height: number } | null = null
// Tracks whether the user has actively drag-resized since app start or last
// reset. DB persistence of `expandedSize` alone isn't enough — a saved size
// from a prior session should not make the reset button visible; only an
// in-session user resize should.
let userHasResized = false
// Set by 'will-resize' (user drag intent); cleared after 'resized' commits.
// 'resized' fires for BOTH user drag AND animated programmatic setBounds on
// macOS — this flag distinguishes them.
let userResizeInFlight = false

function dispatch(event: FsmEvent): void {
  const result = reduce(state, event, ctx)
  if (result.state !== state) {
    state = result.state
  }
  for (const action of result.actions) executeAction(action)
}

// --- Action executor ---

function executeAction(action: Action): void {
  switch (action.kind) {
    case 'create-floating-window':
      if (!floatingAgentWindow || floatingAgentWindow.isDestroyed()) {
        floatingAgentWindow = createFloatingAgentWindow()
      }
      readConfig()
      readExpandedSize()
      return

    case 'destroy-floating-window':
      if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
        floatingAgentWindow.destroy()
      }
      floatingAgentWindow = null
      currentFloatingSession = null
      return

    case 'redirect-session-to-floating':
      if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
        const ok = redirectSessionWindow(action.sessionId, floatingAgentWindow)
        if (ok) {
          currentFloatingSession = readSessionMeta(action.sessionId)
          if (!floatingAgentWindow.isDestroyed()) {
            floatingAgentWindow.webContents.send('floating-agent:session-changed')
          }
        }
      }
      return

    case 'redirect-session-to-main':
      if (mainWindow && !mainWindow.isDestroyed()) {
        redirectSessionWindow(action.sessionId, mainWindow)
      }
      return

    case 'replay-buffer-to-main':
      if (mainWindow && !mainWindow.isDestroyed()) {
        const result = getBufferSince(action.sessionId, -1)
        if (result) {
          for (const chunk of result.chunks) {
            mainWindow.webContents.send('pty:data', action.sessionId, chunk.data, chunk.seq)
          }
        }
      }
      return

    case 'request-resize-main':
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:resize-needed', action.sessionId)
      }
      return

    case 'show-floating':
      if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
        // showInactive() — never steal focus. If we used show() the floating
        // window would activate the app, immediately firing 'did-become-active'
        // and triggering an unwanted reattach loop.
        floatingAgentWindow.showInactive()
      }
      return

    case 'hide-floating':
      if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
        floatingAgentWindow.hide()
      }
      return

    case 'apply-floating-bounds':
      applyBounds(action.animate)
      return

    case 'broadcast-state':
      broadcastState()
      return

    case 'log-diagnostic':
      recordDiagnosticEvent({
        level: 'info',
        source: 'pty',
        event: action.event,
        payload: { state: state.kind, ...(action.payload ?? {}) }
      })
      return

    case 'register-floating-shortcut':
      registerFloatingShortcut()
      return

    case 'unregister-floating-shortcut':
      unregisterFloatingShortcut()
      return

    case 'send-collapse-changed':
      if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
        floatingAgentWindow.webContents.send('floating-agent:collapse-changed', action.collapsed)
      }
      return

    case 'set-collapsed':
      ctx = { ...ctx, collapsed: action.collapsed }
      return

    case 'set-resizable':
      if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
        floatingAgentWindow.setResizable(action.resizable)
        if (action.resizable) {
          floatingAgentWindow.setMinimumSize(EXPANDED_MIN_WIDTH, EXPANDED_MIN_HEIGHT)
        } else {
          // Reset minimum size — otherwise a previous expanded min would
          // clamp the collapsed setBounds() to the bigger value.
          floatingAgentWindow.setMinimumSize(0, 0)
        }
      }
      return

    case 'clear-expanded-size':
      expandedSize = null
      userHasResized = false
      if (saveExpandedSizeTimer) {
        clearTimeout(saveExpandedSizeTimer)
        saveExpandedSizeTimer = null
      }
      getDatabase().prepare("DELETE FROM settings WHERE key = 'floatingAgentExpandedSize'").run()
      broadcastState()
      return
  }
}

function broadcastState(): void {
  const payload = {
    kind: state.kind,
    sessionId: state.kind === 'detached' ? state.sessionId : null,
    mode: state.kind === 'detached' ? state.mode : null,
    hasCustomSize: userHasResized
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('floating-agent:state', payload)
  }
  if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
    floatingAgentWindow.webContents.send('floating-agent:state', payload)
  }
}

function readSessionMeta(sessionId: string): { sessionId: string; cwd: string; mode: string } {
  const db = getDatabase()
  const row = db.prepare("SELECT value FROM settings WHERE key = 'agentPanelState'").get() as { value: string } | undefined
  let cwd = ''
  let mode = 'claude-code'
  try {
    const s = row?.value ? JSON.parse(row.value) : {}
    cwd = s.cwd ?? ''
    mode = s.mode ?? 'claude-code'
  } catch { /* defaults */ }
  return { sessionId, cwd, mode }
}

// --- Anchor Math ---

function calcBounds(
  workArea: Electron.Rectangle,
  position: AnchorPosition,
  widgetWidth: number,
  widgetHeight: number
): Electron.Rectangle {
  const { x, y, width: w, height: h } = workArea
  const m = MARGIN
  switch (position) {
    case 'bottom-right':  return { x: x + w - widgetWidth - m, y: y + h - widgetHeight - m, width: widgetWidth, height: widgetHeight }
    case 'bottom-left':   return { x: x + m, y: y + h - widgetHeight - m, width: widgetWidth, height: widgetHeight }
    case 'top-right':     return { x: x + w - widgetWidth - m, y: y + m, width: widgetWidth, height: widgetHeight }
    case 'top-left':      return { x: x + m, y: y + m, width: widgetWidth, height: widgetHeight }
    case 'center-bottom': return { x: x + Math.round((w - widgetWidth) / 2), y: y + h - widgetHeight - m, width: widgetWidth, height: widgetHeight }
    case 'center-left':   return { x: x + m, y: y + Math.round((h - widgetHeight) / 2), width: widgetWidth, height: widgetHeight }
    case 'center-right':  return { x: x + w - widgetWidth - m, y: y + Math.round((h - widgetHeight) / 2), width: widgetWidth, height: widgetHeight }
  }
}

function getCollapsedSize(): { width: number; height: number } {
  return currentConfig.style === 'icon'
    ? { width: COLLAPSED_ICON_SIZE, height: COLLAPSED_ICON_SIZE }
    : { width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT }
}

function getActiveDisplay(): Electron.Display {
  // Anchor to the main window's display so the floating widget stays on the
  // same screen as SlayZone — not on whatever screen the cursor happens to
  // be on at detach time.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [x, y] = mainWindow.getPosition()
    const [w, h] = mainWindow.getSize()
    return screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) })
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function applyBounds(animate: boolean): void {
  if (!floatingAgentWindow || floatingAgentWindow.isDestroyed()) return
  const display = getActiveDisplay()
  const size = ctx.collapsed
    ? getCollapsedSize()
    : (expandedSize ?? { width: EXPANDED_WIDTH, height: Math.round(display.workArea.height * EXPANDED_HEIGHT_RATIO) })
  const bounds = calcBounds(display.workArea, currentConfig.position, size.width, size.height)
  floatingAgentWindow.setBounds(bounds, animate)
}

function readExpandedSize(): void {
  const db = getDatabase()
  const row = db.prepare("SELECT value FROM settings WHERE key = 'floatingAgentExpandedSize'").get() as { value: string } | undefined
  try {
    if (row?.value) {
      const parsed = JSON.parse(row.value)
      if (typeof parsed?.width === 'number' && typeof parsed?.height === 'number') {
        expandedSize = { width: parsed.width, height: parsed.height }
        return
      }
    }
  } catch { /* ignore */ }
  expandedSize = null
}

let saveExpandedSizeTimer: ReturnType<typeof setTimeout> | null = null
function persistExpandedSize(width: number, height: number): void {
  const wasUserResized = userHasResized
  expandedSize = { width, height }
  userHasResized = true
  // Broadcast immediately on first user resize so reset button appears
  // without waiting for debounced DB write.
  if (!wasUserResized) broadcastState()
  if (saveExpandedSizeTimer) clearTimeout(saveExpandedSizeTimer)
  saveExpandedSizeTimer = setTimeout(() => {
    saveExpandedSizeTimer = null
    const db = getDatabase()
    db.prepare("INSERT INTO settings (key, value) VALUES ('floatingAgentExpandedSize', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ width, height }))
  }, 200)
}

function readConfig(): void {
  const db = getDatabase()
  const row = db.prepare("SELECT value FROM settings WHERE key = 'floatingAgentConfig'").get() as { value: string } | undefined
  try {
    currentConfig = row?.value ? { ...DEFAULT_CONFIG, ...JSON.parse(row.value) } : DEFAULT_CONFIG
  } catch { currentConfig = DEFAULT_CONFIG }
}

// --- Shortcut ---

function getAgentPanelAccelerator(): string | null {
  const overrides = getShortcutOverrides()
  const keys = overrides['agent-panel'] ?? shortcutDefinitions.find(d => d.id === 'agent-panel')?.defaultKeys
  if (!keys) return null
  return toElectronAccelerator(keys)
}

function registerFloatingShortcut(): void {
  unregisterFloatingShortcut()
  const accel = getAgentPanelAccelerator()
  if (!accel) return
  const ok = globalShortcut.register(accel, () => {
    if (state.kind === 'detached') dispatch({ kind: 'user-toggle-collapse' })
  })
  if (ok) registeredAccelerator = accel
}

function unregisterFloatingShortcut(): void {
  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator)
    registeredAccelerator = null
  }
}

// --- Window Factory ---

function createFloatingAgentWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: COLLAPSED_WIDTH,
    height: COLLAPSED_HEIGHT,
    show: false,
    frame: false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#0a0a0a',
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const url = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}?floating=agent`
    : `file://${join(__dirname, '../renderer/index.html')}?floating=agent`
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.loadURL(url)

  win.on('focus', () => dispatch({ kind: 'floating-focus' }))
  win.on('blur', () => dispatch({ kind: 'floating-blur' }))
  win.on('closed', () => {
    floatingAgentWindow = null
    currentFloatingSession = null
    dispatch({ kind: 'floating-window-closed' })
  })
  // 'will-resize' fires only on user-initiated drag (never programmatic).
  // Gate 'resized' on this flag so animated setBounds (which DOES fire
  // 'resized' on macOS) doesn't pollute the persisted size.
  win.on('will-resize', () => {
    userResizeInFlight = true
  })
  win.on('resized', () => {
    if (ctx.collapsed || win.isDestroyed()) return
    if (!userResizeInFlight) return
    userResizeInFlight = false
    const [width, height] = win.getSize()
    persistExpandedSize(width, height)
  })

  return win
}

// --- IPC Handlers ---

function setupFloatingAgentIpc(): void {
  ipcMain.handle('floating-agent:set-enabled', (_event, enabled: boolean) => {
    ctx = { ...ctx, enabled }
    dispatch({ kind: 'user-set-enabled', enabled })
    return { kind: state.kind }
  })

  ipcMain.handle('floating-agent:set-session-id', (_event, sessionId: string | null) => {
    const previous = ctx.sessionId
    ctx = { ...ctx, sessionId }
    if (previous !== sessionId) {
      dispatch({ kind: 'session-id-changed', sessionId })
    }
    return { kind: state.kind }
  })

  ipcMain.handle('floating-agent:set-panel-open', (_event, isOpen: boolean) => {
    ctx = { ...ctx, panelOpen: isOpen }
    dispatch({ kind: 'panel-open-changed', isOpen })
    return { kind: state.kind }
  })

  ipcMain.handle('floating-agent:toggle-collapse', () => {
    dispatch({ kind: 'user-toggle-collapse' })
    return { kind: state.kind, collapsed: ctx.collapsed }
  })

  ipcMain.handle('floating-agent:reset-size', () => {
    dispatch({ kind: 'user-reset-size' })
    return { kind: state.kind }
  })

  ipcMain.handle('floating-agent:detach', () => {
    dispatch({ kind: 'user-detach' })
    return currentStatePayload()
  })

  ipcMain.handle('floating-agent:reattach', () => {
    dispatch({ kind: 'user-reattach' })
    return currentStatePayload()
  })

  ipcMain.handle('floating-agent:get-state', () => currentStatePayload())
  ipcMain.handle('floating-agent:get-session', () => currentFloatingSession)
  ipcMain.handle('floating-agent:get-config', () => currentConfig)
}

function currentStatePayload(): { kind: string; sessionId: string | null; mode: 'auto' | 'manual' | null; hasCustomSize: boolean } {
  return {
    kind: state.kind,
    sessionId: state.kind === 'detached' ? state.sessionId : null,
    mode: state.kind === 'detached' ? state.mode : null,
    hasCustomSize: userHasResized
  }
}

// --- Public API ---

export function attachFloatingAgent(win: BrowserWindow): void {
  mainWindow = win

  // Per-window listeners for OS variants where app-level events don't fire reliably
  win.on('focus', () => dispatch({ kind: 'main-focus' }))
}

export function setupFloatingAgent(overridesGetter?: () => Record<string, string | null>): void {
  if (overridesGetter) getShortcutOverrides = overridesGetter
  setupFloatingAgentIpc()

  // did-resign-active = app-level signal, fires only when user leaves our
  // app entirely (ignores menu/tooltip transient blur). Detach trigger.
  app.on('did-resign-active', () => dispatch({ kind: 'app-resign-active' }))
  // Reattach is driven by per-window main-focus (see attachFloatingAgent).
  // We deliberately do NOT use did-become-active because it fires before
  // window focus resolves — clicking the floating widget would trigger
  // a spurious reattach since getFocusedWindow() returns stale data at
  // that moment.

  app.on('will-quit', () => unregisterFloatingShortcut())
}
