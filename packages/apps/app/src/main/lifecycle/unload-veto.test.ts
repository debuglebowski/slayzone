/**
 * overrideUnloadVetoes — no page can hold a window (or the app's quit) open.
 *
 * Electron shows no "leave page?" dialog: a `beforeunload` veto it is not told to
 * ignore silently cancels the close, and a cancelled close cancels the whole quit.
 * Packaged pilot 2026-11-03: every normal quit hit the 15s watchdog that way.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { overrideUnloadVetoes } from './unload-veto'

function fakeContents(type = 'window') {
  const emitter = new EventEmitter() as EventEmitter & { getType: () => string }
  emitter.getType = () => type
  return emitter
}

describe('overrideUnloadVetoes', () => {
  test('a beforeunload veto is overridden, so the unload proceeds', () => {
    const contents = fakeContents()
    overrideUnloadVetoes(contents, { isQuitting: () => false, record: () => {} })
    const event = { preventDefault: vi.fn() }
    contents.emit('will-prevent-unload', event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  test('records each override with the contents type and whether a quit is under way', () => {
    const contents = fakeContents('webview')
    const record = vi.fn()
    let quitting = false
    overrideUnloadVetoes(contents, { isQuitting: () => quitting, record })
    contents.emit('will-prevent-unload', { preventDefault: () => {} })
    quitting = true
    contents.emit('will-prevent-unload', { preventDefault: () => {} })
    expect(record.mock.calls).toEqual([
      [{ contentsType: 'webview', duringQuit: false }],
      [{ contentsType: 'webview', duringQuit: true }]
    ])
  })

  test('a failing recorder never keeps the veto in force', () => {
    const contents = fakeContents()
    overrideUnloadVetoes(contents, {
      isQuitting: () => true,
      record: () => {
        throw new Error('diagnostics closed')
      }
    })
    const event = { preventDefault: vi.fn() }
    expect(() => contents.emit('will-prevent-unload', event)).not.toThrow()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })
})
