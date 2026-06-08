import { BrowserWindow, ipcMain, app, screen, webContents } from 'electron'
import { EventEmitter } from 'node:events'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { redirectSessionWindow, getBufferSince } from '@slayzone/terminal/electron'

interface OwnershipKey {
  taskId: string
  panelId: string
}

function ownershipKey(taskId: string, panelId: string): string {
  return `${taskId}::${panelId}`
}

const ownership = new Map<string, number>() // key → owner webContents.id
const taskWindows = new Map<number, { window: BrowserWindow; taskId: string }>() // webContents.id → entry
let primaryWindow: BrowserWindow | null = null
// Primary's active task tracker (lifted to module scope so taskWindowsOps reads
// it). Secondaries follow this for "Follow current tab" mode.
let primaryActiveTaskId: string | null = null

// tRPC event stream — dual-emitted alongside the legacy `task-window:*` /
// `panels:*` webContents.send broadcasts below, so the `app.taskWindows`
// subscriptions work while the renderer still consumes IPC (coexistence until
// slice 5; the sends drop then). `panels-close-request` carries the target
// windowId so the matching tRPC connection can filter (per-window delivery).
export const taskWindowsEvents = new EventEmitter() as EventEmitter & {
  on(event: 'list-changed', listener: (taskIds: string[]) => void): EventEmitter
  on(event: 'primary-active-changed', listener: (taskId: string | null) => void): EventEmitter
  on(
    event: 'ownership-changed',
    listener: (payload: {
      taskId: string
      ownership: Array<{ panelId: string; ownerWindowId: number }>
    }) => void
  ): EventEmitter
  on(
    event: 'panels-released-on-close',
    listener: (payload: {
      closedWindowId: number
      released: Array<{ taskId: string; panelId: string }>
    }) => void
  ): EventEmitter
  on(
    event: 'panels-close-request',
    listener: (targetWindowId: number, payload: { taskId: string; panelId: string }) => void
  ): EventEmitter
  off(event: string, listener: (...args: unknown[]) => void): EventEmitter
}

export function attachTaskWindows(win: BrowserWindow): void {
  primaryWindow = win
}

function allWindows(): BrowserWindow[] {
  const out: BrowserWindow[] = []
  if (primaryWindow && !primaryWindow.isDestroyed()) out.push(primaryWindow)
  for (const entry of taskWindows.values()) {
    if (!entry.window.isDestroyed()) out.push(entry.window)
  }
  return out
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of allWindows()) {
    try {
      w.webContents.send(channel, ...args)
    } catch {
      /* ignore */
    }
  }
}

function ownershipSnapshotForTask(
  taskId: string
): Array<{ panelId: string; ownerWindowId: number }> {
  const out: Array<{ panelId: string; ownerWindowId: number }> = []
  for (const [key, ownerWindowId] of ownership.entries()) {
    const [tid, panelId] = key.split('::')
    if (tid === taskId) out.push({ panelId, ownerWindowId })
  }
  return out
}

function broadcastOwnership(taskId: string): void {
  const ownership = ownershipSnapshotForTask(taskId)
  broadcast('panels:ownership-changed', { taskId, ownership }) // legacy IPC (slice 5 drops)
  taskWindowsEvents.emit('ownership-changed', { taskId, ownership }) // tRPC app.taskWindows.onOwnershipChanged
}

function openTaskIds(): string[] {
  const out: string[] = []
  for (const entry of taskWindows.values()) {
    if (!entry.window.isDestroyed()) out.push(entry.taskId)
  }
  return out
}

function broadcastTaskWindowList(): void {
  const taskIds = openTaskIds()
  broadcast('task-window:list-changed', taskIds) // legacy IPC (slice 5 drops)
  taskWindowsEvents.emit('list-changed', taskIds) // tRPC app.taskWindows.onListChanged
}

function createSecondaryTaskWindow(taskId: string): BrowserWindow {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const w = 1100
  const h = 760
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: display.workArea.x + Math.round((display.workArea.width - w) / 2),
    y: display.workArea.y + Math.round((display.workArea.height - h) / 2),
    show: true,
    title: 'SlayZone',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 10, y: 12 },
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })
  const params = new URLSearchParams({ taskWindow: taskId })
  const url =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? `${process.env['ELECTRON_RENDERER_URL']}?${params.toString()}`
      : `file://${join(__dirname, '../renderer/index.html')}?${params.toString()}`
  win.loadURL(url)
  const wcId = win.webContents.id
  taskWindows.set(wcId, { window: win, taskId })

  win.on('closed', () => {
    const closedWcId = wcId
    taskWindows.delete(closedWcId)
    broadcastTaskWindowList()

    // Release ownership entries held by this window. Group by taskId for broadcasts.
    const releasedTasks = new Set<string>()
    const releasedKeys: OwnershipKey[] = []
    for (const [key, ownerWindowId] of ownership.entries()) {
      if (ownerWindowId === closedWcId) {
        ownership.delete(key)
        const [taskId, panelId] = key.split('::')
        releasedKeys.push({ taskId, panelId })
        releasedTasks.add(taskId)
      }
    }
    for (const taskId of releasedTasks) broadcastOwnership(taskId)
    if (releasedKeys.length > 0) {
      broadcast('panels:released-on-close', { closedWindowId: closedWcId, released: releasedKeys }) // legacy IPC (slice 5 drops)
      taskWindowsEvents.emit('panels-released-on-close', {
        closedWindowId: closedWcId,
        released: releasedKeys
      }) // tRPC app.taskWindows.onPanelsReleasedOnClose
    }
  })

  return win
}

// Single impl behind BOTH the `task-window:*` / `panels:*` / `pty:claim-session`
// IPC handlers and the tRPC `app.taskWindows.*` procedures (coexistence until
// slice 5). The caller's window id is passed explicitly — IPC supplies
// `event.sender.id`, tRPC supplies `ctx.windowId` (same value: webContents.id).
export const taskWindowsOps = {
  open: (taskId: string) => {
    if (!taskId) return { ok: false }
    // If a secondary already exists for this task, focus it instead of spawning another
    for (const entry of taskWindows.values()) {
      if (entry.taskId === taskId && !entry.window.isDestroyed()) {
        entry.window.focus()
        return { ok: true, focused: true }
      }
    }
    createSecondaryTaskWindow(taskId)
    broadcastTaskWindowList()
    return { ok: true }
  },
  close: (taskId: string) => {
    let closed = 0
    for (const entry of Array.from(taskWindows.values())) {
      if (entry.taskId === taskId && !entry.window.isDestroyed()) {
        entry.window.close()
        closed++
      }
    }
    return { ok: true, closed }
  },
  list: () => openTaskIds(),
  // Primary-only: secondaries calling this are silently ignored.
  setPrimaryActive: (taskId: string | null, callerWindowId: number | null) => {
    if (callerWindowId == null || primaryWindow?.webContents.id !== callerWindowId) {
      return { ok: false }
    }
    primaryActiveTaskId = taskId
    broadcast('task-window:primary-active-changed', taskId) // legacy IPC (slice 5 drops)
    taskWindowsEvents.emit('primary-active-changed', taskId) // tRPC app.taskWindows.onPrimaryActiveChanged
    return { ok: true }
  },
  getPrimaryActive: () => primaryActiveTaskId,
  claimPanel: (taskId: string, panelId: string, ownerWindowId: number) => {
    const key = ownershipKey(taskId, panelId)
    const prev = ownership.get(key)
    if (prev === ownerWindowId) return { ok: true, unchanged: true }
    ownership.set(key, ownerWindowId)
    broadcastOwnership(taskId)
    return { ok: true }
  },
  releasePanel: (taskId: string, panelId: string, callerWindowId: number) => {
    const key = ownershipKey(taskId, panelId)
    const prev = ownership.get(key)
    if (prev === undefined) return { ok: true, unchanged: true }
    if (prev !== callerWindowId) return { ok: false, reason: 'not-owner' }
    ownership.delete(key)
    broadcastOwnership(taskId)
    return { ok: true }
  },
  // Release all panels owned by caller for the given task. Used when secondary's
  // TaskDetailPage unmounts (Follow-current-tab swap) — prevents stale ownership.
  releaseAllForTask: (taskId: string, callerWindowId: number) => {
    const prefix = `${taskId}::`
    let released = 0
    for (const [key, ownerId] of Array.from(ownership.entries())) {
      if (ownerId === callerWindowId && key.startsWith(prefix)) {
        ownership.delete(key)
        released++
      }
    }
    if (released > 0) broadcastOwnership(taskId)
    return { ok: true, released }
  },
  getOwnership: (taskId: string) => ownershipSnapshotForTask(taskId),
  getWindowId: (callerWindowId: number) => callerWindowId,
  // "Take over and close": claim panel + send close-request to previous owner
  // so its renderer flips local panelVisibility[id]=false (no DB write).
  claimAndCloseOther: (taskId: string, panelId: string, ownerWindowId: number) => {
    const key = ownershipKey(taskId, panelId)
    const prevOwnerId = ownership.get(key)
    ownership.set(key, ownerWindowId)
    broadcastOwnership(taskId)
    if (prevOwnerId !== undefined && prevOwnerId !== ownerWindowId) {
      // Send close-request to prev owner only (legacy IPC + targeted tRPC emit)
      const targets: BrowserWindow[] = []
      if (
        primaryWindow &&
        !primaryWindow.isDestroyed() &&
        primaryWindow.webContents.id === prevOwnerId
      )
        targets.push(primaryWindow)
      for (const entry of taskWindows.values()) {
        if (!entry.window.isDestroyed() && entry.window.webContents.id === prevOwnerId)
          targets.push(entry.window)
      }
      for (const w of targets) {
        try {
          w.webContents.send('panels:close-request', { taskId, panelId }) // legacy IPC (slice 5 drops)
        } catch {
          /* ignore */
        }
      }
      taskWindowsEvents.emit('panels-close-request', prevOwnerId, { taskId, panelId }) // tRPC app.taskWindows.onPanelCloseRequest (filtered by windowId)
    }
    return { ok: true }
  },
  // Multi-window PTY claim: redirects PTY output to claiming window + replays buffer.
  // Used by AgentSidePanel (and future shared sessions) to follow active window.
  claimSession: (sessionId: string, callerWindowId: number) => {
    const wc = webContents.fromId(callerWindowId)
    const win = wc ? BrowserWindow.fromWebContents(wc) : null
    if (!win || win.isDestroyed()) return { ok: false }
    const ok = redirectSessionWindow(sessionId, win)
    if (!ok) return { ok: false }
    const result = getBufferSince(sessionId, -1)
    if (result) {
      for (const chunk of result.chunks) {
        try {
          win.webContents.send('pty:data', sessionId, chunk.data, chunk.seq)
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: true }
  }
}

export function setupTaskWindows(): void {
  // Legacy IPC handlers — delegate to taskWindowsOps (slice 5 drops these).
  ipcMain.handle('task-window:open', (_e, taskId: string) => taskWindowsOps.open(taskId))
  ipcMain.handle('task-window:close', (_e, taskId: string) => taskWindowsOps.close(taskId))
  ipcMain.handle('task-window:list', () => taskWindowsOps.list())
  ipcMain.handle('task-window:set-primary-active', (event, taskId: string | null) =>
    taskWindowsOps.setPrimaryActive(taskId, event.sender.id)
  )
  ipcMain.handle('task-window:get-primary-active', () => taskWindowsOps.getPrimaryActive())
  ipcMain.handle('panels:claim', (event, taskId: string, panelId: string) =>
    taskWindowsOps.claimPanel(taskId, panelId, event.sender.id)
  )
  ipcMain.handle('panels:release', (event, taskId: string, panelId: string) =>
    taskWindowsOps.releasePanel(taskId, panelId, event.sender.id)
  )
  ipcMain.handle('panels:release-all-for-task', (event, taskId: string) =>
    taskWindowsOps.releaseAllForTask(taskId, event.sender.id)
  )
  ipcMain.handle('panels:get-ownership', (_e, taskId: string) =>
    taskWindowsOps.getOwnership(taskId)
  )
  ipcMain.handle('panels:get-window-id', (event) => taskWindowsOps.getWindowId(event.sender.id))
  ipcMain.handle('panels:claim-and-close-other', (event, taskId: string, panelId: string) =>
    taskWindowsOps.claimAndCloseOther(taskId, panelId, event.sender.id)
  )
  ipcMain.handle('pty:claim-session', (event, sessionId: string) =>
    taskWindowsOps.claimSession(sessionId, event.sender.id)
  )

  app.on('before-quit', () => {
    for (const entry of taskWindows.values()) {
      if (!entry.window.isDestroyed()) entry.window.destroy()
    }
    taskWindows.clear()
    ownership.clear()
  })
}

export function getTaskWindowsForTaskId(taskId: string): BrowserWindow[] {
  const out: BrowserWindow[] = []
  for (const entry of taskWindows.values()) {
    if (entry.taskId === taskId && !entry.window.isDestroyed()) out.push(entry.window)
  }
  return out
}
