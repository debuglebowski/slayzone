import { afterEach, describe, expect, it, vi } from 'vitest'
import { isModalDialogOpen } from './is-modal-dialog-open'
import { withModalGuard } from './with-modal-guard'

function openModal(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('isModalDialogOpen', () => {
  it('detects an open modal dialog or alert dialog', () => {
    expect(isModalDialogOpen()).toBe(false)
    const dialog = openModal()
    expect(isModalDialogOpen()).toBe(true)
    dialog.setAttribute('role', 'alertdialog')
    expect(isModalDialogOpen()).toBe(true)
    dialog.setAttribute('aria-modal', 'false')
    expect(isModalDialogOpen()).toBe(false)
  })

  it('queries the DOM once per event, however many handlers ask', () => {
    const query = vi.spyOn(document, 'querySelector')
    const event = new KeyboardEvent('keydown', { key: 'a' })
    for (let i = 0; i < 50; i++) isModalDialogOpen(event)
    expect(query).toHaveBeenCalledTimes(1)

    // A new event asks the DOM again — the answer is not cached across events.
    openModal()
    expect(isModalDialogOpen(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('re-queries on every call made without an event', () => {
    const query = vi.spyOn(document, 'querySelector')
    isModalDialogOpen()
    isModalDialogOpen()
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('withModalGuard', () => {
  it('shares one modal check across every guarded handler of a keystroke', () => {
    const query = vi.spyOn(document, 'querySelector')
    const handlers = Array.from({ length: 20 }, () => vi.fn())
    const listeners = handlers.map((h) => withModalGuard(h))
    for (const l of listeners) window.addEventListener('keydown', l)
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    } finally {
      for (const l of listeners) window.removeEventListener('keydown', l)
    }
    for (const h of handlers) expect(h).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('skips the handler while a modal is open', () => {
    openModal()
    const handler = vi.fn()
    withModalGuard(handler)(new KeyboardEvent('keydown', { key: 'x' }))
    expect(handler).not.toHaveBeenCalled()
  })
})
