import { BrowserWindow, ipcMain, app, screen } from 'electron'
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
    try { w.webContents.send(channel, ...args) } catch { /* ignore */ }
  }
}

function ownershipSnapshotForTask(taskId: string): Array<{ panelId: string; ownerWindowId: number }> {
  const out: Array<{ panelId: string; ownerWindowId: number }> = []
  for (const [key, ownerWindowId] of ownership.entries()) {
    const [tid, panelId] = key.split('::')
    if (tid === taskId) out.push({ panelId, ownerWindowId })
  }
  return out
}

function broadcastOwnership(taskId: string): void {
  broadcast('panels:ownership-changed', { taskId, ownership: ownershipSnapshotForTask(taskId) })
}

function openTaskIds(): string[] {
  const out: string[] = []
  for (const entry of taskWindows.values()) {
    if (!entry.window.isDestroyed()) out.push(entry.taskId)
  }
  return out
}

function broadcastTaskWindowList(): void {
  broadcast('task-window:list-changed', openTaskIds())
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
  const url = is.dev && process.env['ELECTRON_RENDERER_URL']
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
      broadcast('panels:released-on-close', { closedWindowId: closedWcId, released: releasedKeys })
    }
  })

  return win
}

export function setupTaskWindows(): void {
  ipcMain.handle('task-window:open', (_e, taskId: string) => {
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
  })

  ipcMain.handle('task-window:close', (_e, taskId: string) => {
    let closed = 0
    for (const entry of Array.from(taskWindows.values())) {
      if (entry.taskId === taskId && !entry.window.isDestroyed()) {
        entry.window.close()
        closed++
      }
    }
    return { ok: true, closed }
  })

  ipcMain.handle('task-window:list', () => openTaskIds())

  // Primary's active task tracker. Broadcast to all secondaries so "Follow current tab"
  // mode in secondary can swap to whatever task primary is showing.
  let primaryActiveTaskId: string | null = null
  ipcMain.handle('task-window:set-primary-active', (event, taskId: string | null) => {
    if (event.sender !== primaryWindow?.webContents) return { ok: false } // primary only
    primaryActiveTaskId = taskId
    broadcast('task-window:primary-active-changed', taskId)
    return { ok: true }
  })
  ipcMain.handle('task-window:get-primary-active', () => primaryActiveTaskId)

  ipcMain.handle('panels:claim', (event, taskId: string, panelId: string) => {
    const ownerWindowId = event.sender.id
    const key = ownershipKey(taskId, panelId)
    const prev = ownership.get(key)
    if (prev === ownerWindowId) return { ok: true, unchanged: true }
    ownership.set(key, ownerWindowId)
    broadcastOwnership(taskId)
    return { ok: true }
  })

  ipcMain.handle('panels:release', (event, taskId: string, panelId: string) => {
    const key = ownershipKey(taskId, panelId)
    const prev = ownership.get(key)
    if (prev === undefined) return { ok: true, unchanged: true }
    if (prev !== event.sender.id) return { ok: false, reason: 'not-owner' }
    ownership.delete(key)
    broadcastOwnership(taskId)
    return { ok: true }
  })

  // Release all panels owned by sender for the given task. Used when secondary's
  // TaskDetailPage unmounts (Follow-current-tab swap) — prevents stale ownership.
  ipcMain.handle('panels:release-all-for-task', (event, taskId: string) => {
    const senderId = event.sender.id
    const prefix = `${taskId}::`
    let released = 0
    for (const [key, ownerId] of Array.from(ownership.entries())) {
      if (ownerId === senderId && key.startsWith(prefix)) {
        ownership.delete(key)
        released++
      }
    }
    if (released > 0) broadcastOwnership(taskId)
    return { ok: true, released }
  })

  ipcMain.handle('panels:get-ownership', (_e, taskId: string) => {
    return ownershipSnapshotForTask(taskId)
  })

  ipcMain.handle('panels:get-window-id', (event) => {
    return event.sender.id
  })

  // "Take over and close": claim panel + send close-request to previous owner
  // so its renderer flips local panelVisibility[id]=false (no DB write).
  ipcMain.handle('panels:claim-and-close-other', (event, taskId: string, panelId: string) => {
    const ownerWindowId = event.sender.id
    const key = ownershipKey(taskId, panelId)
    const prevOwnerId = ownership.get(key)
    ownership.set(key, ownerWindowId)
    broadcastOwnership(taskId)
    if (prevOwnerId !== undefined && prevOwnerId !== ownerWindowId) {
      // Send close-request to prev owner only
      const targets: BrowserWindow[] = []
      if (primaryWindow && !primaryWindow.isDestroyed() && primaryWindow.webContents.id === prevOwnerId) targets.push(primaryWindow)
      for (const entry of taskWindows.values()) {
        if (!entry.window.isDestroyed() && entry.window.webContents.id === prevOwnerId) targets.push(entry.window)
      }
      for (const w of targets) {
        try { w.webContents.send('panels:close-request', { taskId, panelId }) } catch { /* ignore */ }
      }
    }
    return { ok: true }
  })

  // Multi-window PTY claim: redirects PTY output to claiming window + replays buffer.
  // Used by AgentSidePanel (and future shared sessions) to follow active window.
  ipcMain.handle('pty:claim-session', (event, sessionId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return { ok: false }
    const ok = redirectSessionWindow(sessionId, win)
    if (!ok) return { ok: false }
    const result = getBufferSince(sessionId, -1)
    if (result) {
      for (const chunk of result.chunks) {
        try { win.webContents.send('pty:data', sessionId, chunk.data, chunk.seq) } catch { /* ignore */ }
      }
    }
    return { ok: true }
  })

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
