import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

vi.mock('@slayzone/ui', () => ({
  IconButton: (props: {
    onClick?: () => void
    'aria-label': string
    children?: React.ReactNode
  }) => (
    <button aria-label={props['aria-label']} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Tooltip: (props: { children?: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children?: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: () => null
}))

import { MediaView } from './MediaView'

let imageCount = 0
const realImage = globalThis.Image

class MockImage {
  _src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 400
  naturalHeight = 300
  complete = false
  constructor() {
    imageCount++
  }
  set src(v: string) {
    this._src = v
    this.complete = true
    queueMicrotask(() => {
      if (this.onload) this.onload()
    })
  }
  get src() {
    return this._src
  }
}

const realGetBCR = Element.prototype.getBoundingClientRect
function stubBCR(w: number, h: number) {
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: w,
      bottom: h,
      width: w,
      height: h,
      toJSON: () => ({})
    } as DOMRect
  }
}

beforeEach(() => {
  imageCount = 0
  ;(globalThis as unknown as { Image: typeof MockImage }).Image = MockImage
  stubBCR(800, 600)
})

afterEach(() => {
  cleanup()
  ;(globalThis as unknown as { Image: typeof realImage }).Image = realImage
  Element.prototype.getBoundingClientRect = realGetBCR
})

describe('MediaView raster image', () => {
  it('renders a canvas element for image source', () => {
    const { container } = render(
      <MediaView source={{ kind: 'image', src: 'data:image/png;base64,' }} />
    )
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('renders Fit + Full buttons by default', () => {
    const { container } = render(
      <MediaView source={{ kind: 'image', src: 'data:image/png;base64,' }} />
    )
    expect(container.querySelector('[aria-label="Fit to view"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Full size"]')).not.toBeNull()
  })

  it('hides controls when showControls=false', () => {
    const { container } = render(
      <MediaView source={{ kind: 'image', src: 'data:image/png;base64,' }} showControls={false} />
    )
    expect(container.querySelector('[aria-label="Fit to view"]')).toBeNull()
  })
})

describe('MediaView SVG vector', () => {
  it('inlines SVG markup directly (no <img> load, no canvas)', () => {
    const { container } = render(
      <MediaView
        source={{ kind: 'svg', svg: '<svg viewBox="0 0 100 100" data-testid="inline"/>' }}
      />
    )
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('[data-testid="inline"]')).not.toBeNull()
    expect(imageCount).toBe(0)
  })

  it('renders Fit + Full buttons for SVG source', () => {
    const { container } = render(
      <MediaView source={{ kind: 'svg', svg: '<svg viewBox="0 0 100 100"/>' }} />
    )
    expect(container.querySelector('[aria-label="Fit to view"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Full size"]')).not.toBeNull()
  })

  it('updates inline SVG when svg prop changes', () => {
    const { container, rerender } = render(
      <MediaView source={{ kind: 'svg', svg: '<svg data-testid="a" viewBox="0 0 10 10"/>' }} />
    )
    expect(container.querySelector('[data-testid="a"]')).not.toBeNull()
    rerender(
      <MediaView source={{ kind: 'svg', svg: '<svg data-testid="b" viewBox="0 0 20 20"/>' }} />
    )
    expect(container.querySelector('[data-testid="a"]')).toBeNull()
    expect(container.querySelector('[data-testid="b"]')).not.toBeNull()
  })
})

describe('MediaView raster Fit/Full', () => {
  it('Fit click computes fit transform; Full click computes full transform', async () => {
    const calls: { x: number; y: number; scale: number }[] = []
    vi.resetModules()
    vi.doMock('./usePanZoom', async () => {
      const React = await import('react')
      return {
        usePanZoom: () => {
          const hostRef = React.useRef<HTMLDivElement | null>(null)
          const contentRef = React.useRef<HTMLDivElement | null>(null)
          const controls = React.useMemo(
            () => ({
              setTransform: (t: { x: number; y: number; scale: number }) => {
                calls.push(t)
              },
              getTransform: () => ({ x: 0, y: 0, scale: 1 }),
              zoomIn: () => {},
              zoomOut: () => {},
              reset: () => {},
              fit: () => {}
            }),
            []
          )
          return { hostRef, contentRef, controls }
        }
      }
    })
    vi.doMock('@slayzone/ui', () => ({
      IconButton: (props: {
        onClick?: () => void
        'aria-label': string
        children?: React.ReactNode
      }) => (
        <button aria-label={props['aria-label']} onClick={props.onClick}>
          {props.children}
        </button>
      ),
      Tooltip: (props: { children?: React.ReactNode }) => <>{props.children}</>,
      TooltipTrigger: (props: { children?: React.ReactNode }) => <>{props.children}</>,
      TooltipContent: () => null
    }))
    const { MediaView: Mocked } = await import('./MediaView')

    const { container, rerender } = render(
      <Mocked source={{ kind: 'image', src: 'data:image/png;base64,' }} />
    )
    await act(async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })

    // Initial fit applied via refitIfFitMode after image load.
    // Host = 800×600 (stubBCR), image = 400×300 (MockImage):
    //   scale = min(800/400, 600/300) = 2, x = 0, y = 0
    expect(calls.at(-1)).toEqual({ x: 0, y: 0, scale: 2 })

    const fullBtn = container.querySelector('[aria-label="Full size"]') as HTMLButtonElement
    await act(async () => {
      fullBtn.click()
    })
    expect(calls.at(-1)).toEqual({ x: 200, y: 150, scale: 1 })

    const callsAfterFull = calls.length

    rerender(<Mocked source={{ kind: 'image', src: 'data:image/png;base64,' }} />)
    rerender(<Mocked source={{ kind: 'image', src: 'data:image/png;base64,' }} />)
    await act(async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })
    expect(calls.length).toBe(callsAfterFull)

    const fitBtn = container.querySelector('[aria-label="Fit to view"]') as HTMLButtonElement
    await act(async () => {
      fitBtn.click()
    })
    expect(calls.at(-1)).toEqual({ x: 0, y: 0, scale: 2 })

    vi.doUnmock('./usePanZoom')
    vi.doUnmock('@slayzone/ui')
  })
})

describe('MediaView SVG Fit/Full', () => {
  it('refits on content change + resize only while in fit mode, with the new dims', async () => {
    const calls: { x: number; y: number; scale: number }[] = []
    const roCallbacks: Array<() => void> = []
    const realRO = globalThis.ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      cb: () => void
      constructor(cb: () => void) {
        this.cb = cb
      }
      observe() {
        roCallbacks.push(this.cb)
      }
      disconnect() {
        const i = roCallbacks.indexOf(this.cb)
        if (i >= 0) roCallbacks.splice(i, 1)
      }
    }
    vi.resetModules()
    vi.doMock('./usePanZoom', async () => {
      const React = await import('react')
      return {
        usePanZoom: () => {
          const hostRef = React.useRef<HTMLDivElement | null>(null)
          const contentRef = React.useRef<HTMLDivElement | null>(null)
          const controls = React.useMemo(
            () => ({
              setTransform: (t: { x: number; y: number; scale: number }) => {
                calls.push(t)
              },
              getTransform: () => ({ x: 0, y: 0, scale: 1 }),
              zoomIn: () => {},
              zoomOut: () => {},
              reset: () => {},
              fit: () => {}
            }),
            []
          )
          return { hostRef, contentRef, controls }
        }
      }
    })
    vi.doMock('@slayzone/ui', () => ({
      IconButton: (props: {
        onClick?: () => void
        'aria-label': string
        children?: React.ReactNode
      }) => (
        <button aria-label={props['aria-label']} onClick={props.onClick}>
          {props.children}
        </button>
      ),
      Tooltip: (props: { children?: React.ReactNode }) => <>{props.children}</>,
      TooltipTrigger: (props: { children?: React.ReactNode }) => <>{props.children}</>,
      TooltipContent: () => null
    }))
    const { MediaView: Mocked } = await import('./MediaView')
    const svg = (w: number, h: number) => ({
      kind: 'svg' as const,
      svg: `<svg viewBox="0 0 ${w} ${h}"/>`
    })
    const resize = () =>
      act(() => {
        for (const cb of [...roCallbacks]) cb()
      })

    // Host = 800×600 (stubBCR).
    const { container, rerender } = render(<Mocked source={svg(100, 50)} />)
    // Mount refit: scale = min(8, 12) = 8 → 800×400 centered.
    expect(calls.at(-1)).toEqual({ x: 0, y: 100, scale: 8 })

    // Content change while fitting refits against the NEW intrinsic dims.
    rerender(<Mocked source={svg(200, 100)} />)
    expect(calls.at(-1)).toEqual({ x: 0, y: 100, scale: 4 })
    const n1 = calls.length
    resize()
    expect(calls.length).toBe(n1 + 1)
    expect(calls.at(-1)).toEqual({ x: 0, y: 100, scale: 4 })

    // Full mode: neither resize nor a content change refits.
    act(() => {
      ;(container.querySelector('[aria-label="Full size"]') as HTMLButtonElement).click()
    })
    expect(calls.at(-1)).toEqual({ x: 300, y: 250, scale: 1 })
    const n2 = calls.length
    resize()
    rerender(<Mocked source={svg(400, 300)} />)
    resize()
    expect(calls.length).toBe(n2)

    // Back to fit: uses the latest content's dims; resize refits again.
    act(() => {
      ;(container.querySelector('[aria-label="Fit to view"]') as HTMLButtonElement).click()
    })
    expect(calls.at(-1)).toEqual({ x: 0, y: 0, scale: 2 })
    const n3 = calls.length
    resize()
    expect(calls.length).toBe(n3 + 1)

    vi.doUnmock('./usePanZoom')
    vi.doUnmock('@slayzone/ui')
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO
  })
})
