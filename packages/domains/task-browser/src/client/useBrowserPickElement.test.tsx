// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { DOM_PICKER_CANCEL_SCRIPT, DOM_PICKER_SCRIPT } from './dom-picker-runtime'
import { useBrowserPickElement } from './useBrowserPickElement'
import type { BrowserTabPlaceholderHandle } from './BrowserTabPlaceholder'

type Actions = NonNullable<BrowserTabPlaceholderHandle['actions']>

/** Picker script never resolves (user still picking); cancel script settles per `cancel`. */
function makeActions(cancel: 'resolve' | 'reject') {
  const executeJs = vi.fn((code: string) => {
    if (code === DOM_PICKER_SCRIPT) return new Promise<unknown>(() => {})
    if (code === DOM_PICKER_CANCEL_SCRIPT)
      return cancel === 'resolve' ? Promise.resolve(null) : Promise.reject(new Error('gone'))
    return Promise.resolve(null)
  })
  return { actions: { executeJs } as unknown as Actions, executeJs }
}

function setup(actions: Actions) {
  return renderHook(
    ({ extensionsManagerOpen }) =>
      useBrowserPickElement({
        activeActions: actions,
        extensionsManagerOpen,
        canUseDomPicker: true,
        multiDeviceMode: false
      }),
    { initialProps: { extensionsManagerOpen: false } }
  )
}

describe('useBrowserPickElement cancellation', () => {
  it('opening the extensions manager cancels an active pick', async () => {
    const { actions, executeJs } = makeActions('resolve')
    const { result, rerender } = setup(actions)

    act(() => {
      void result.current.startPickElement()
    })
    expect(result.current.isPickingElement).toBe(true)

    rerender({ extensionsManagerOpen: true })
    expect(executeJs).toHaveBeenCalledWith(DOM_PICKER_CANCEL_SCRIPT)
    await waitFor(() => expect(result.current.isPickingElement).toBe(false))
  })

  it('a failing cancel script still leaves picker mode', async () => {
    const { actions } = makeActions('reject')
    const { result } = setup(actions)

    act(() => {
      void result.current.startPickElement()
    })
    expect(result.current.isPickingElement).toBe(true)

    await act(async () => {
      await result.current.cancelPickElement()
    })
    expect(result.current.isPickingElement).toBe(false)
  })

  it('cancel stays in picker mode until the cancel script settles', async () => {
    let settle: () => void = () => {}
    const executeJs = vi.fn((code: string) =>
      code === DOM_PICKER_CANCEL_SCRIPT
        ? new Promise<unknown>((resolve) => {
            settle = () => resolve(null)
          })
        : new Promise<unknown>(() => {})
    )
    const { result } = setup({ executeJs } as unknown as Actions)

    act(() => {
      void result.current.startPickElement()
    })
    let cancelled: Promise<void> = Promise.resolve()
    act(() => {
      cancelled = result.current.cancelPickElement()
    })
    expect(result.current.isPickingElement).toBe(true)

    await act(async () => {
      settle()
      await cancelled
    })
    expect(result.current.isPickingElement).toBe(false)
  })

  it('without an active view, cancel is a resolved no-op', async () => {
    const { result } = renderHook(() =>
      useBrowserPickElement({
        activeActions: undefined,
        extensionsManagerOpen: false,
        canUseDomPicker: true,
        multiDeviceMode: false
      })
    )
    await expect(result.current.cancelPickElement()).resolves.toBeUndefined()
    expect(result.current.isPickingElement).toBe(false)
  })
})
