import { describe, expect, it } from 'vitest'
import { isOutsideWindow, planNativeBounds } from './browser-view-park'

const WIN = { width: 1200, height: 800 }

describe('isOutsideWindow', () => {
  it('park position is outside', () => {
    expect(isOutsideWindow({ x: -20000, y: -20000, width: 800, height: 600 }, WIN)).toBe(true)
  })

  it('on-screen and partially overlapping rects are inside', () => {
    expect(isOutsideWindow({ x: 100, y: 50, width: 800, height: 600 }, WIN)).toBe(false)
    expect(isOutsideWindow({ x: -790, y: -590, width: 800, height: 600 }, WIN)).toBe(false)
    expect(isOutsideWindow({ x: 0, y: 0, width: 1, height: 1 }, WIN)).toBe(false)
  })

  it('touching an edge without overlap is outside', () => {
    expect(isOutsideWindow({ x: -800, y: 0, width: 800, height: 600 }, WIN)).toBe(true)
    expect(isOutsideWindow({ x: 1200, y: 0, width: 800, height: 600 }, WIN)).toBe(true)
    expect(isOutsideWindow({ x: 0, y: 800, width: 800, height: 600 }, WIN)).toBe(true)
  })
})

describe('planNativeBounds', () => {
  const park = { x: -20000, y: -20000, width: 800, height: 600 }

  it('reattaches a parked view whose page is still at its creation size', () => {
    expect(
      planNativeBounds(park, { attached: true, outside: true, nativeSize: { width: 1, height: 1 } })
    ).toBe('reattach')
  })

  it('reattaches when the native size is unknown', () => {
    expect(planNativeBounds(park, { attached: true, outside: true, nativeSize: null })).toBe(
      'reattach'
    )
  })

  it('plain set when the parked size already matches (position-only move)', () => {
    expect(
      planNativeBounds(park, {
        attached: true,
        outside: true,
        nativeSize: { width: 800, height: 600 }
      })
    ).toBe('set')
  })

  it('plain set on screen or while detached', () => {
    const tiny = { width: 1, height: 1 }
    expect(planNativeBounds(park, { attached: true, outside: false, nativeSize: tiny })).toBe('set')
    expect(planNativeBounds(park, { attached: false, outside: true, nativeSize: tiny })).toBe('set')
  })
})
