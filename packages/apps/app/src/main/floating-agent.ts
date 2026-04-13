import { BrowserWindow, ipcMain, screen, globalShortcut, app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { redirectSessionWindow, getBufferSince } from '@slayzone/terminal/main'
import { toElectronAccelerator, shortcutDefinitions } from '@slayzone/shortcuts'
import { getDatabase } from './db'

// --- Types ---

type AnchorPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center-bottom' | 'center-left' | 'center-right'
type WidgetStyle = 'widget' | 'icon'

interface FloatingAgentConfig {
  style: WidgetStyle
  position: AnchorPosition
}

// --- Constants ---

const DEFAULT_CONFIG: FloatingAgentConfig = { style: 'widget', position: 'bottom-right' }
const COLLAPSED_WIDTH = 138
const COLLAPSED_HEIGHT = 52
const COLLAPSED_ICON_SIZE = 44
const EXPANDED_WIDTH = 360
const EXPANDED_HEIGHT_RATIO = 0.5
const MARGIN = 0

// --- Shortcut ---

let registeredAccelerator: string | null = null
let getShortcutOverrides: () => Record<string, string> = () => ({})

function getAgentPanelAccelerator(): string | null {
  const overrides = getShortcutOverrides()
  const keys = overrides['agent-panel'] || shortcutDefinitions.find(d => d.id === 'agent-panel')?.defaultKeys
  if (!keys) return null
  return toElectronAccelerator(keys)
}

function registerFloatingShortcut(): void {
  unregisterFloatingShortcut()
  const accel = getAgentPanelAccelerator()
  if (!accel) return
  const ok = globalShortcut.register(accel, () => {
    if (floatingDetached) toggleCollapse()
  })
  if (ok) registeredAccelerator = accel
}

function unregisterFloatingShortcut(): void {
  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator)
    registeredAccelerator = null
  }
}

// --- State ---

let mainWindow: BrowserWindow | null = null
let floatingAgentWindow: BrowserWindow | null = null
let floatingBlurDebounce: ReturnType<typeof setTimeout> | null = null
let blurCursorPoint: Electron.Point | null = null
let lastDetachTime = 0
let currentFloatingSession: { sessionId: string; cwd: string; mode: string } | null = null
let floatingDetached = false
let isCollapsed = true
let currentConfig: FloatingAgentConfig = DEFAULT_CONFIG
let displayFollowInterval: ReturnType<typeof setInterval> | null = null
let lastDisplayId: number | null = null

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
  const cursor = blurCursorPoint ?? screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(cursor)
}

function applyBounds(animate = false): void {
  if (!floatingAgentWindow || floatingAgentWindow.isDestroyed()) return
  const display = getActiveDisplay()
  const size = isCollapsed
    ? getCollapsedSize()
    : { width: EXPANDED_WIDTH, height: Math.round(display.workArea.height * EXPANDED_HEIGHT_RATIO) }
  const bounds = calcBounds(display.workArea, currentConfig.position, size.width, size.height)
  floatingAgentWindow.setBounds(bounds, animate)
}

function readConfig(): void {
  const db = getDatabase()
  const row = db.prepare("SELECT value FROM settings WHERE key = 'floatingAgentConfig'").get() as { value: string } | undefined
  try {
    currentConfig = row?.value ? { ...DEFAULT_CONFIG, ...JSON.parse(row.value) } : DEFAULT_CONFIG
  } catch { currentConfig = DEFAULT_CONFIG }
}

// --- Collapse/Expand ---

function toggleCollapse(): void {
  if (!floatingAgentWindow || floatingAgentWindow.isDestroyed()) return
  isCollapsed = !isCollapsed
  applyBounds(true) // native animation
  floatingAgentWindow.webContents.send('floating-agent:collapse-changed', isCollapsed)
}

// --- Window Factory ---

function createFloatingAgentWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: COLLAPSED_WIDTH,
    height: COLLAPSED_HEIGHT,
    show: false,
    alwaysOnTop: true,
    frame: false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#0a0a0a',
    roundedCorners: true,
    ...(process.platform === 'darwin' ? { visibleOnAllWorkspaces: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    }
  })

  const url = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? `${process.env['ELECTRON_RENDERER_URL']}?floating=agent`
    : `file://${join(__dirname, '../renderer/index.html')}?floating=agent`
  win.loadURL(url)

  win.on('focus', () => {
    if (floatingBlurDebounce) {
      clearTimeout(floatingBlurDebounce)
      floatingBlurDebounce = null
    }
  })

  win.on('closed', () => {
    floatingAgentWindow = null
    currentFloatingSession = null
  })

  return win
}

// --- Display Follow ---

function startDisplayFollow(): void {
  stopDisplayFollow()
  lastDisplayId = null
  displayFollowInterval = setInterval(() => {
    if (!floatingAgentWindow || floatingAgentWindow.isDestroyed() || !floatingDetached) {
      stopDisplayFollow()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    if (display.id === lastDisplayId) return
    lastDisplayId = display.id
    applyBounds()
  }, 500)
}

function stopDisplayFollow(): void {
  if (displayFollowInterval) {
    clearInterval(displayFollowInterval)
    displayFollowInterval = null
  }
  lastDisplayId = null
}

// --- IPC Handlers ---

function setupFloatingAgentIpc(): void {
  ipcMain.handle('floating-agent:detach', (_event, sessionId: string, _panelWidth: number) => {
    if (!mainWindow || floatingDetached) return
    if (!floatingAgentWindow) floatingAgentWindow = createFloatingAgentWindow()

    const ok = redirectSessionWindow(sessionId, floatingAgentWindow)
    if (!ok) return
    floatingDetached = true
    lastDetachTime = Date.now()

    readConfig()
    isCollapsed = true
    applyBounds()

    const db = getDatabase()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'agentPanelState'").get() as { value: string } | undefined
    let cwd = ''
    let mode = 'claude-code'
    try {
      const state = row?.value ? JSON.parse(row.value) : {}
      cwd = state.cwd ?? ''
      mode = state.mode ?? 'claude-code'
    } catch { /* use defaults */ }
    currentFloatingSession = { sessionId, cwd, mode }
    if (!floatingAgentWindow.isDestroyed()) {
      floatingAgentWindow.webContents.send('floating-agent:session-changed')
      floatingAgentWindow.webContents.send('floating-agent:collapse-changed', true)
    }
    floatingAgentWindow.show()
    startDisplayFollow()
    registerFloatingShortcut()
  })

  ipcMain.handle('floating-agent:reattach', (_event, sessionId: string) => {
    if (!floatingDetached) return
    floatingDetached = false
    stopDisplayFollow()
    unregisterFloatingShortcut()
    if (mainWindow && !mainWindow.isDestroyed()) {
      redirectSessionWindow(sessionId, mainWindow)
      const result = getBufferSince(sessionId, -1)
      if (result) {
        for (const chunk of result.chunks) {
          mainWindow.webContents.send('pty:data', sessionId, chunk.data, chunk.seq)
        }
      }
      mainWindow.webContents.send('pty:resize-needed', sessionId)
    }
    if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
      floatingAgentWindow.hide()
    }
  })

  ipcMain.handle('floating-agent:get-session', () => currentFloatingSession)
  ipcMain.handle('floating-agent:get-config', () => currentConfig)
  ipcMain.handle('floating-agent:toggle-collapse', () => toggleCollapse())
}

// --- Public API ---

export function attachFloatingAgentBlurHandlers(win: BrowserWindow): void {
  mainWindow = win

  win.on('blur', () => {
    blurCursorPoint = screen.getCursorScreenPoint()
    floatingBlurDebounce = setTimeout(() => {
      floatingBlurDebounce = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:window-blur')
      }
    }, 80)
  })

  win.on('focus', () => {
    if (floatingBlurDebounce) {
      clearTimeout(floatingBlurDebounce)
      floatingBlurDebounce = null
    }
    if (Date.now() - lastDetachTime < 500) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:window-focus')
    }
  })

  win.on('closed', () => {
    mainWindow = null
    if (floatingAgentWindow && !floatingAgentWindow.isDestroyed()) {
      floatingAgentWindow.close()
    }
  })
}

export function setupFloatingAgent(overridesGetter?: () => Record<string, string>): void {
  if (overridesGetter) getShortcutOverrides = overridesGetter
  setupFloatingAgentIpc()
  app.on('will-quit', () => unregisterFloatingShortcut())
}
