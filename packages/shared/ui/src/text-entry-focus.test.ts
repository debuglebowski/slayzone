// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { isTextEntryElement } from './text-entry-focus'

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host
}

describe('isTextEntryElement', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('counts fields a user types into', () => {
    const host = mount(
      '<input id="a"><input id="b" type="search"><input id="c" type="email"><textarea id="d"></textarea><div id="e" contenteditable="true"></div>'
    )
    // jsdom doesn't implement isContentEditable; a browser derives it from the attribute.
    Object.defineProperty(host.querySelector('#e')!, 'isContentEditable', { value: true })
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(isTextEntryElement(host.querySelector(`#${id}`)), id).toBe(true)
    }
  })

  it('does not count controls nobody types into', () => {
    const host = mount(
      '<input id="a" type="checkbox"><input id="b" type="radio"><input id="c" type="button"><input id="d" type="range"><select id="e"></select><button id="f"></button>'
    )
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(isTextEntryElement(host.querySelector(`#${id}`)), id).toBe(false)
    }
  })

  it('does not count read-only or disabled fields', () => {
    const host = mount('<input id="a" readonly><textarea id="b" disabled></textarea>')
    expect(isTextEntryElement(host.querySelector('#a'))).toBe(false)
    expect(isTextEntryElement(host.querySelector('#b'))).toBe(false)
  })

  it("does not count a terminal's input surface", () => {
    // xterm's keyboard surface is a <textarea>; a terminal is not a text field.
    const host = mount(
      '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>'
    )
    expect(isTextEntryElement(host.querySelector('textarea'))).toBe(false)
  })

  it('handles nothing focused', () => {
    expect(isTextEntryElement(null)).toBe(false)
    expect(isTextEntryElement(document.body)).toBe(false)
  })
})
