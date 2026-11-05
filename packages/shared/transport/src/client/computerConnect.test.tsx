// @vitest-environment jsdom
/**
 * A subscription the hub refused while no computer was there (the file editor's
 * watch during the desktop's boot window: "connect a computer") stays errored —
 * the open file then never sees an external change until it is remounted. When a
 * computer connects (the app shell bumps the generation), an errored subscription
 * starts again; a healthy one is left alone.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteComputerConnected, useResubscribeOnComputerConnect } from './computerConnect'

afterEach(cleanup)

describe('resubscribe on computer connect', () => {
  it('an errored subscription restarts when a computer connects', () => {
    const reset = vi.fn()
    renderHook(() => useResubscribeOnComputerConnect({ status: 'error', reset }))
    expect(reset, 'nothing on mount').not.toHaveBeenCalled()
    act(() => noteComputerConnected())
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('a live one is not touched', () => {
    const reset = vi.fn()
    renderHook(() => useResubscribeOnComputerConnect({ status: 'pending', reset }))
    act(() => noteComputerConnected())
    expect(reset).not.toHaveBeenCalled()
  })
})
