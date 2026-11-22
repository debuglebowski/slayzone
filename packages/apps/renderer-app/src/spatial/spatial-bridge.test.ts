import { describe, expect, it, vi } from 'vitest'
import { createSpatialBridge, type SpatialHostWindow } from './spatial-bridge'

function nativeWindow() {
  const postMessage = vi.fn()
  const win: SpatialHostWindow = {
    location: { origin: 'http://localhost:4000', pathname: '/' },
    open: vi.fn(() => null),
    close: vi.fn(),
    webkit: { messageHandlers: { slayzoneSpatial: { postMessage } } }
  }
  return { win, postMessage }
}

function browserWindow() {
  const win: SpatialHostWindow = {
    location: { origin: 'http://localhost:4000', pathname: '/app/' },
    open: vi.fn(() => null),
    close: vi.fn()
  }
  return { win }
}

describe('spatial bridge inside the native visionOS host', () => {
  it('reports native', () => {
    expect(createSpatialBridge(nativeWindow().win).isNative).toBe(true)
  })

  it('asks the host to open a task panel', () => {
    const { win, postMessage } = nativeWindow()
    createSpatialBridge(win).open({ panel: 'task', taskId: 't1' }, 'Fix login')
    expect(postMessage).toHaveBeenCalledWith({
      type: 'open',
      route: { panel: 'task', taskId: 't1' },
      url: 'http://localhost:4000/?spatial=task&task=t1',
      title: 'Fix login'
    })
    expect(win.open).not.toHaveBeenCalled()
  })

  it('asks the host to close the current panel', () => {
    const { win, postMessage } = nativeWindow()
    createSpatialBridge(win).close()
    expect(postMessage).toHaveBeenCalledWith({ type: 'close' })
    expect(win.close).not.toHaveBeenCalled()
  })
})

describe('spatial bridge in a plain browser', () => {
  it('reports not native', () => {
    expect(createSpatialBridge(browserWindow().win).isNative).toBe(false)
  })

  it('opens an independent browser window, keeping the page path', () => {
    const { win } = browserWindow()
    createSpatialBridge(win).open({ panel: 'board', projectId: 'p1' }, 'SlayZone')
    expect(win.open).toHaveBeenCalledWith(
      'http://localhost:4000/app/?spatial=board&project=p1',
      '_blank',
      'noopener'
    )
  })

  it('closes the browser window', () => {
    const { win } = browserWindow()
    createSpatialBridge(win).close()
    expect(win.close).toHaveBeenCalled()
  })
})
