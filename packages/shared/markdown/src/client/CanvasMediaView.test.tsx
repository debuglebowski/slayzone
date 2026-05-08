import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useState } from 'react'

vi.mock('@slayzone/ui', () => ({
  IconButton: (props: { onClick?: () => void; 'aria-label': string; children?: React.ReactNode }) => (
    <button aria-label={props['aria-label']} onClick={props.onClick}>{props.children}</button>
  ),
  Tooltip: (props: { children?: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children?: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: () => null,
}))

import { CanvasMediaView } from './CanvasMediaView'

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
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect
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

describe('CanvasMediaView', () => {
  it('renders a canvas element', () => {
    const { container } = render(<CanvasMediaView source={{ kind: 'image', src: 'data:image/png;base64,' }} />)
    expect(container.querySelector('canvas')).not.toBeNull()
  })

  it('renders Fit + Full buttons by default', () => {
    const { container } = render(<CanvasMediaView source={{ kind: 'image', src: 'data:image/png;base64,' }} />)
    expect(container.querySelector('[aria-label="Fit to view"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Full size"]')).not.toBeNull()
  })

  it('hides controls when showControls=false', () => {
    const { container } = render(<CanvasMediaView source={{ kind: 'image', src: 'data:image/png;base64,' }} showControls={false} />)
    expect(container.querySelector('[aria-label="Fit to view"]')).toBeNull()
  })

  it('does not reload image when parent re-renders with a fresh source object literal but same data', async () => {
    function Parent() {
      const [, setTick] = useState(0)
      return (
        <div>
          <button data-testid="rerender" onClick={() => setTick((t) => t + 1)}>tick</button>
          <CanvasMediaView source={{ kind: 'svg', svg: '<svg viewBox="0 0 100 100"/>' }} />
        </div>
      )
    }
    const { container } = render(<Parent />)
    // Wait for the initial async load.
    await act(async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })
    const initial = imageCount
    expect(initial).toBeGreaterThan(0)

    const btn = container.querySelector('[data-testid="rerender"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
      btn.click()
      btn.click()
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })
    // Effect must not re-run on parent re-render — primitive-value deps in
    // CanvasMediaView guard against fresh `{kind, svg}` literals each render.
    expect(imageCount).toBe(initial)
  })

  it('reloads when the underlying svg string changes', async () => {
    function Parent({ svg }: { svg: string }) {
      return <CanvasMediaView source={{ kind: 'svg', svg }} />
    }
    const { rerender } = render(<Parent svg='<svg viewBox="0 0 10 10"/>' />)
    await act(async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })
    const after1 = imageCount
    rerender(<Parent svg='<svg viewBox="0 0 20 20"/>' />)
    await act(async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })
    expect(imageCount).toBeGreaterThan(after1)
  })
})

// Separate suite using a mocked usePanZoom so we can record setTransform calls
// and verify Fit/Full buttons compute the right transforms.
describe('CanvasMediaView Fit/Full buttons', () => {
  // We can't easily share the mock with the previous suite (factory hoisting),
  // so this lives in its own file via dynamic import after vi.mock setup.
  // For simplicity we inline a separate test that exercises the buttons through
  // a spy installed via vi.doMock + dynamic import.

  it('Fit click computes fit transform; Full click computes full transform; re-renders do not clobber', async () => {
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
              fit: () => {},
            }),
            [],
          )
          return { hostRef, contentRef, controls }
        },
      }
    })
    vi.doMock('@slayzone/ui', () => ({
      IconButton: (props: { onClick?: () => void; 'aria-label': string; children?: React.ReactNode }) => (
        <button aria-label={props['aria-label']} onClick={props.onClick}>{props.children}</button>
      ),
      Tooltip: (props: { children?: React.ReactNode }) => <>{props.children}</>,
      TooltipTrigger: (props: { children?: React.ReactNode }) => <>{props.children}</>,
      TooltipContent: () => null,
    }))
    const { CanvasMediaView: Mocked } = await import('./CanvasMediaView')

    const { container, rerender } = render(<Mocked source={{ kind: 'svg', svg: '<svg viewBox="0 0 100 100"/>' }} />)
    await act(async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })

    // Initial fit applied. Host = 800×600 (stubbed), src = 400×300 (MockImage):
    //   scale = min(800/400, 600/300) = 2, x = 0, y = 0
    expect(calls.at(-1)).toEqual({ x: 0, y: 0, scale: 2 })

    // Click Full → centered native size: x = (800-400)/2 = 200, y = (600-300)/2 = 150, scale = 1
    const fullBtn = container.querySelector('[aria-label="Full size"]') as HTMLButtonElement
    await act(async () => { fullBtn.click() })
    expect(calls.at(-1)).toEqual({ x: 200, y: 150, scale: 1 })

    const callsAfterFull = calls.length

    // Force a parent re-render with the same source content. setTransform must
    // NOT be called again (no spurious reset to fit).
    rerender(<Mocked source={{ kind: 'svg', svg: '<svg viewBox="0 0 100 100"/>' }} />)
    rerender(<Mocked source={{ kind: 'svg', svg: '<svg viewBox="0 0 100 100"/>' }} />)
    await act(async () => {
      await new Promise<void>((r) => queueMicrotask(() => r()))
    })
    expect(calls.length).toBe(callsAfterFull)

    // Click Fit → back to fit transform.
    const fitBtn = container.querySelector('[aria-label="Fit to view"]') as HTMLButtonElement
    await act(async () => { fitBtn.click() })
    expect(calls.at(-1)).toEqual({ x: 0, y: 0, scale: 2 })

    vi.doUnmock('./usePanZoom')
    vi.doUnmock('@slayzone/ui')
  })
})
