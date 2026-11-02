import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {},
  app: {},
  screen: {},
  shell: {},
  webContents: {}
}))
vi.mock('@slayzone/terminal/electron', () => ({
  redirectSessionWindow: vi.fn(),
  getBufferSince: vi.fn()
}))
vi.mock('./document-link-bridge', () => ({ attachDocumentLinkBridges: vi.fn() }))
vi.mock('./app-window-navigation-guard', () => ({ attachAppWindowNavigationGuard: vi.fn() }))

const { attachTaskWindows, taskWindowsOps, taskWindowsEvents } = await import('./task-windows')

function windowWithId(id: number) {
  const win = Object.assign(new EventEmitter(), {
    webContents: { id, send: vi.fn() },
    isDestroyed: () => false
  })
  return { win, browserWindow: win as unknown as BrowserWindow }
}

afterEach(() => taskWindowsEvents.removeAllListeners())

describe('primary panel ownership lifecycle', () => {
  it('releases every task on primary close so a reopened window can claim panels', () => {
    const old = windowWithId(1)
    attachTaskWindows(old.browserWindow)
    taskWindowsOps.setPrimaryActive('t1', 1)
    taskWindowsOps.claimPanel('t1', 'terminal', 1)
    taskWindowsOps.claimPanel('t2', 'terminal', 1)
    taskWindowsOps.claimPanel('t1', 'browser', 9)
    const changed = vi.fn()
    const released = vi.fn()
    taskWindowsEvents.on('ownership-changed', changed)
    taskWindowsEvents.on('panels-released-on-close', released)

    old.win.emit('closed')
    expect(taskWindowsOps.getPrimaryActive()).toBeNull()
    const next = windowWithId(2)
    attachTaskWindows(next.browserWindow)

    expect(taskWindowsOps.getOwnership('t1')).toEqual([{ panelId: 'browser', ownerWindowId: 9 }])
    expect(taskWindowsOps.getOwnership('t2')).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(released).toHaveBeenCalledWith({
      closedWindowId: 1,
      released: [
        { taskId: 't1', panelId: 'terminal' },
        { taskId: 't2', panelId: 'terminal' }
      ]
    })
    taskWindowsOps.claimPanel('t1', 'terminal', 2)
    expect(taskWindowsOps.getOwnership('t1')).toContainEqual({
      panelId: 'terminal',
      ownerWindowId: 2
    })
    taskWindowsOps.releaseAllForTask('t1', 2)
    taskWindowsOps.releaseAllForTask('t1', 9)
    next.win.emit('closed')
  })
})
