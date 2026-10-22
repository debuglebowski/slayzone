// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { focusOwnsUndoKey } from './undo-key-target'

/** A keydown fired at `target`, as react-hotkeys-hook hands it to an undo handler. */
function keydownAt(target: Element, mods: { metaKey?: boolean; ctrlKey?: boolean }): KeyboardEvent {
  let event: KeyboardEvent | undefined
  target.addEventListener('keydown', (e) => (event = e as KeyboardEvent), { once: true })
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true, ...mods }))
  return event!
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host
}

describe('focusOwnsUndoKey', () => {
  afterEach(() => document.body.replaceChildren())

  it('leaves ⌘Z to text fields and editors — they have their own text undo', () => {
    const host = mount(
      '<input id="i"><textarea id="t"></textarea><div id="ce" contenteditable="true"></div>' +
        '<div class="cm-editor"><div id="cm"></div></div>'
    )
    for (const id of ['i', 't', 'ce', 'cm']) {
      const el = host.querySelector(`#${id}`)!
      // jsdom has no isContentEditable; mirror the browser for the contenteditable div.
      if (id === 'ce') Object.defineProperty(el, 'isContentEditable', { value: true })
      expect(focusOwnsUndoKey(keydownAt(el, { metaKey: true })), id).toBe(true)
    }
  })

  it('takes ⌘Z from a terminal — xterm sends the shell nothing for ⌘+letter', () => {
    const host = mount(
      '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>'
    )
    const helper = host.querySelector('.xterm-helper-textarea')!
    expect(focusOwnsUndoKey(keydownAt(helper, { metaKey: true }))).toBe(false)
  })

  it('leaves Ctrl+Z to a terminal — it is the shell’s suspend key', () => {
    const host = mount(
      '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>'
    )
    const helper = host.querySelector('.xterm-helper-textarea')!
    expect(focusOwnsUndoKey(keydownAt(helper, { ctrlKey: true }))).toBe(true)
  })

  it('takes ⌘Z / Ctrl+Z from plain app chrome', () => {
    const host = mount('<button id="b">x</button>')
    const button = host.querySelector('#b')!
    expect(focusOwnsUndoKey(keydownAt(button, { metaKey: true }))).toBe(false)
    expect(focusOwnsUndoKey(keydownAt(button, { ctrlKey: true }))).toBe(false)
    expect(focusOwnsUndoKey(keydownAt(document.body, { metaKey: true }))).toBe(false)
  })
})
