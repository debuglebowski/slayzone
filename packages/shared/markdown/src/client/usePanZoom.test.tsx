import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { usePanZoom, type PanZoomControls } from './usePanZoom'

interface HarnessProps {
  svg: string
  hostSize?: { w: number; h: number }
  controlsRef: React.MutableRefObject<PanZoomControls | null>
  hostRefOut: React.MutableRefObject<HTMLDivElement | null>
  contentRefOut: React.MutableRefObject<HTMLDivElement | null>
  fitOnMount?: boolean
}

function Harness({ svg, hostSize, controlsRef, hostRefOut, contentRefOut, fitOnMount = false }: HarnessProps) {
  const { hostRef, contentRef, controls } = usePanZoom({ fitOnMount })
  const initRef = useRef(false)
  useEffect(() => {
    controlsRef.current = controls
    hostRefOut.current = hostRef.current
    contentRefOut.current = contentRef.current
    if (initRef.current) return
    initRef.current = true
    if (hostSize && hostRef.current) {
      const el = hostRef.current
      const rect = { x: 0, y: 0, top: 0, left: 0, right: hostSize.w, bottom: hostSize.h, width: hostSize.w, height: hostSize.h, toJSON: () => ({}) }
      el.getBoundingClientRect = () => rect as DOMRect
      Object.defineProperty(el, 'clientWidth', { value: hostSize.w, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: hostSize.h, configurable: true })
    }
  })
  return (
    <div ref={hostRef} style={{ position: 'relative', width: hostSize?.w, height: hostSize?.h }}>
      <div ref={contentRef} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  )
}

function flushRaf() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

function parseTransform(el: HTMLElement | null): { x: number; y: number; scale: number } {
  if (!el) return { x: 0, y: 0, scale: 1 }
  const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)\s*scale\(([-\d.]+)\)/.exec(el.style.transform)
  if (!m) return { x: 0, y: 0, scale: 1 }
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), scale: parseFloat(m[3]) }
}

afterEach(() => cleanup())

describe('usePanZoom', () => {
  let controls: React.MutableRefObject<PanZoomControls | null>
  let host: React.MutableRefObject<HTMLDivElement | null>
  let content: React.MutableRefObject<HTMLDivElement | null>

  beforeEach(() => {
    controls = { current: null }
    host = { current: null }
    content = { current: null }
  })

  it('fits a 100x50 viewBox in a 200x200 host: scale=2, x=0, y=50', async () => {
    render(
      <Harness
        svg='<svg viewBox="0 0 100 50"></svg>'
        hostSize={{ w: 200, h: 200 }}
        controlsRef={controls}
        hostRefOut={host}
        contentRefOut={content}
      />,
    )
    await act(async () => {
      controls.current!.fit()
      await flushRaf()
    })
    const t = parseTransform(content.current)
    expect(t.scale).toBeCloseTo(2)
    expect(t.x).toBeCloseTo(0)
    expect(t.y).toBeCloseTo(50)
  })

  it('zoomIn applies sensitivity step at host center', async () => {
    render(
      <Harness
        svg='<svg viewBox="0 0 100 100"></svg>'
        hostSize={{ w: 200, h: 200 }}
        controlsRef={controls}
        hostRefOut={host}
        contentRefOut={content}
      />,
    )
    await act(async () => {
      controls.current!.setTransform({ x: 0, y: 0, scale: 1 })
      await flushRaf()
    })
    await act(async () => {
      controls.current!.zoomIn()
      await flushRaf()
    })
    const t = parseTransform(content.current)
    expect(t.scale).toBeCloseTo(1.4) // default sensitivity 0.4 → 1+0.4
  })

  it('coalesces rapid setTransform calls into a single transform write per frame', async () => {
    render(
      <Harness
        svg='<svg viewBox="0 0 100 100"></svg>'
        hostSize={{ w: 200, h: 200 }}
        controlsRef={controls}
        hostRefOut={host}
        contentRefOut={content}
      />,
    )
    await act(async () => {
      controls.current!.setTransform({ x: 0, y: 0, scale: 1 })
      await flushRaf()
    })
    await act(async () => {
      controls.current!.setTransform({ x: 1, y: 1, scale: 1 })
      controls.current!.setTransform({ x: 2, y: 2, scale: 1 })
      controls.current!.setTransform({ x: 3, y: 3, scale: 1 })
      await flushRaf()
    })
    // Last write wins — coalesced.
    const t = parseTransform(content.current)
    expect(t.x).toBeCloseTo(3)
    expect(t.y).toBeCloseTo(3)
  })

  it('wheel event with deltaY<0 zooms in anchored at cursor', async () => {
    render(
      <Harness
        svg='<svg viewBox="0 0 100 100"></svg>'
        hostSize={{ w: 200, h: 200 }}
        controlsRef={controls}
        hostRefOut={host}
        contentRefOut={content}
      />,
    )
    await act(async () => {
      controls.current!.setTransform({ x: 0, y: 0, scale: 1 })
      await flushRaf()
    })
    await act(async () => {
      const ev = new WheelEvent('wheel', { deltaY: -100, clientX: 100, clientY: 100, bubbles: true, cancelable: true })
      content.current!.dispatchEvent(ev)
      await flushRaf()
    })
    expect(parseTransform(content.current).scale).toBeGreaterThan(1)
  })
})
