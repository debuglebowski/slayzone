// @vitest-environment jsdom
// Runs the runtime the file handler injects (`@slayzone/platform/artifact-controls`)
// against a real DOM: what a screen and a controls frame do with the author's markup.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildArtifactControlsRuntime,
  type ArtifactPreviewMode
} from '@slayzone/platform/artifact-controls'

const BODY = `<main id="screen">Screen</main>
<div class="wrap">
  <slay-artifact-controls position="top" id="top">
    <button data-action="next">Next</button>
    <button data-action="tab" data-value="2">Two</button>
    <input type="range" name="qty" value="3">
    <input type="checkbox" name="dark">
    <button data-action="bad id">Bad</button>
  </slay-artifact-controls>
</div>
<slay-artifact-controls id="bottom"><button data-action="reset">Reset</button></slay-artifact-controls>`

/** A fresh frame per test: the runtime's listeners must not outlive it. */
function load(mode: ArtifactPreviewMode) {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const win = frame.contentWindow! as Window & typeof globalThis
  const doc = win.document
  doc.body.innerHTML = BODY
  const { css, script } = buildArtifactControlsRuntime(mode)
  const style = doc.createElement('style')
  style.textContent = css
  doc.head.append(style)
  // The frame's parent is this window: the host.
  const toHost = vi.spyOn(win.parent, 'postMessage').mockImplementation(() => {})
  // jsdom runs no scripts in frames: evaluate it with the frame's window as its
  // global, as the browser would (`with` resolves `window`, `document`, … on it).
  new Function('frameWindow', `with (frameWindow) { ${script} }`)(win)
  return { win, doc, toHost }
}

const actionsSent = (toHost: ReturnType<typeof load>['toHost']) =>
  toHost.mock.calls
    .map(([data]) => data as { type: string })
    .filter(({ type }) => type === 'slayzone:prototype-action')

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('screen', () => {
  it('turns host-relayed actions into slay:action events', () => {
    const { win } = load({ kind: 'screen' })
    const seen: unknown[] = []
    win.addEventListener('slay:action', (e) => seen.push((e as CustomEvent).detail))
    const data = { type: 'slayzone:prototype-action', action: 'qty', value: 4 }
    win.dispatchEvent(new win.MessageEvent('message', { source: win.parent, data }))
    win.dispatchEvent(new win.MessageEvent('message', { source: null, data }))
    win.dispatchEvent(
      new win.MessageEvent('message', { source: win.parent, data: { type: 'other', action: 'x' } })
    )
    expect(seen).toEqual([{ action: 'qty', value: 4 }])
  })
})

describe('controls', () => {
  it('shows only its position, moved up to <body> so it can be nested anywhere', () => {
    const { doc, toHost } = load({ kind: 'controls', position: 'top' })
    const top = doc.getElementById('top')!
    expect(doc.documentElement.getAttribute('data-slz-controls')).toBe('top')
    expect(top.parentElement).toBe(doc.body)
    expect(top.hasAttribute('data-slz-active')).toBe(true)
    expect(doc.getElementById('bottom')!.hasAttribute('data-slz-active')).toBe(false)
    // The screen stays in the document for the page's own scripts.
    expect(doc.getElementById('screen')).not.toBeNull()
    expect(toHost).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'slayzone:artifact-controls-size' }),
      '*'
    )
  })

  it('sends clicks on [data-action] and named field input to the host', () => {
    const { win, doc, toHost } = load({ kind: 'controls', position: 'top' })
    const button = (name: string) =>
      [...doc.querySelectorAll('button')].find((b) => b.textContent === name)!
    const warn = vi.spyOn(win.console, 'warn').mockImplementation(() => {})
    button('Next').click()
    button('Two').click()
    button('Bad').click()
    const range = doc.querySelector<HTMLInputElement>('input[name=qty]')!
    range.value = '7'
    range.dispatchEvent(new win.Event('input', { bubbles: true }))
    const box = doc.querySelector<HTMLInputElement>('input[name=dark]')!
    box.checked = true
    box.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(actionsSent(toHost)).toEqual([
      { type: 'slayzone:prototype-action', action: 'next' },
      { type: 'slayzone:prototype-action', action: 'tab', value: '2' },
      { type: 'slayzone:prototype-action', action: 'qty', value: 7 },
      { type: 'slayzone:prototype-action', action: 'dark', value: true }
    ])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('forwards slay:action events a page dispatches itself, without reaching window', () => {
    const { win, doc, toHost } = load({ kind: 'controls', position: 'top' })
    const onWindow = vi.fn()
    win.addEventListener('slay:action', onWindow)
    doc.getElementById('top')!.dispatchEvent(
      new win.CustomEvent('slay:action', {
        bubbles: true,
        detail: { action: 'custom', value: null }
      })
    )
    expect(actionsSent(toHost)).toEqual([
      { type: 'slayzone:prototype-action', action: 'custom', value: null }
    ])
    expect(onWindow).not.toHaveBeenCalled()
  })

  it('ignores clicks outside its own controls', () => {
    const { doc, toHost } = load({ kind: 'controls', position: 'bottom' })
    doc.querySelector<HTMLButtonElement>('[data-action=next]')!.click()
    doc.querySelector<HTMLButtonElement>('[data-action=reset]')!.click()
    expect(actionsSent(toHost)).toEqual([{ type: 'slayzone:prototype-action', action: 'reset' }])
  })

  it('takes readiness and the app theme from the host only', () => {
    const { win, doc } = load({ kind: 'controls', position: 'top' })
    const root = doc.documentElement
    const ready = {
      type: 'slayzone:prototype-ready',
      ready: true,
      theme: { popover: 'oklch(0.2 0 0)', border: 'red;}body{x:y', colorScheme: 'dark' }
    }
    win.dispatchEvent(new win.MessageEvent('message', { source: win, data: ready }))
    expect(root.hasAttribute('data-slz-ready')).toBe(false)
    win.dispatchEvent(new win.MessageEvent('message', { source: win.parent, data: ready }))
    expect(root.hasAttribute('data-slz-ready')).toBe(true)
    expect(root.style.getPropertyValue('--slz-popover')).toBe('oklch(0.2 0 0)')
    expect(root.style.getPropertyValue('--slz-border')).toBe('')
    expect(root.style.getPropertyValue('color-scheme')).toBe('dark')
  })
})
