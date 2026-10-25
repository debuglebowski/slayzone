// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import {
  createLinkClickPlugin,
  resolveLinkClickTarget,
  resolveReadOnlyLinkClickTarget
} from './milkdown-link-click'

afterEach(() => {
  document.body.innerHTML = ''
})

async function createEditor(markdown: string, onOpenLink: (href: string, t: string) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, container)
      ctx.set(defaultValueCtx, markdown)
    })
    .use(commonmark)
    .use(gfm)
    .use(createLinkClickPlugin(onOpenLink))
    .create()
  return { editor, container }
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  el.dispatchEvent(e)
  return e
}

describe('resolveLinkClickTarget', () => {
  const mods = (m: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey', boolean>>) => ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...m
  })

  it('⌘ → in-app browser, ⌘⇧ → external (terminal/chat convention)', () => {
    expect(resolveLinkClickTarget('https://a.b/', mods({ metaKey: true }))).toBe('in-app-browser')
    expect(resolveLinkClickTarget('https://a.b/', mods({ metaKey: true, shiftKey: true }))).toBe(
      'external'
    )
    expect(resolveLinkClickTarget('https://a.b/', mods({ ctrlKey: true }))).toBe('in-app-browser')
  })

  it('bare click leaves the editor alone (caret placement)', () => {
    expect(resolveLinkClickTarget('https://a.b/', mods({}))).toBeNull()
    expect(resolveLinkClickTarget('https://a.b/', mods({ shiftKey: true }))).toBeNull()
  })

  it('mailto always goes external; other schemes are never opened', () => {
    expect(resolveLinkClickTarget('mailto:a@b.c', mods({ metaKey: true }))).toBe('external')
    expect(resolveLinkClickTarget('javascript:alert(1)', mods({ metaKey: true }))).toBeNull()
    expect(resolveLinkClickTarget('artifact:abc', mods({ metaKey: true }))).toBeNull()
    expect(resolveLinkClickTarget('file:///etc/passwd', mods({ metaKey: true }))).toBeNull()
  })
})

describe('resolveReadOnlyLinkClickTarget', () => {
  const none = { metaKey: false, ctrlKey: false, shiftKey: false }
  it('bare click opens externally; modifiers follow the editor convention', () => {
    expect(resolveReadOnlyLinkClickTarget('https://a.b/', none)).toBe('external')
    expect(resolveReadOnlyLinkClickTarget('https://a.b/', { ...none, metaKey: true })).toBe(
      'in-app-browser'
    )
    expect(
      resolveReadOnlyLinkClickTarget('https://a.b/', { ...none, metaKey: true, shiftKey: true })
    ).toBe('external')
    expect(resolveReadOnlyLinkClickTarget('mailto:a@b.c', none)).toBe('external')
  })
  it('never opens other schemes', () => {
    expect(resolveReadOnlyLinkClickTarget('javascript:alert(1)', none)).toBeNull()
    expect(resolveReadOnlyLinkClickTarget('./rel.md', { ...none, metaKey: true })).toBeNull()
  })
})

describe('createLinkClickPlugin', () => {
  it('opens a markdown link on ⌘ click', async () => {
    const onOpenLink = vi.fn()
    const { editor, container } = await createEditor('[site](https://example.com/)', onOpenLink)
    const a = container.querySelector('a[href="https://example.com/"]')!
    const e = click(a, { metaKey: true })
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com/', 'in-app-browser')
    expect(e.defaultPrevented).toBe(true)
    await editor.destroy()
  })

  it('opens a bare GFM autolink externally on ⌘⇧ click', async () => {
    const onOpenLink = vi.fn()
    const { editor, container } = await createEditor('see https://example.org/ now', onOpenLink)
    const a = container.querySelector('a[href="https://example.org/"]')!
    click(a, { metaKey: true, shiftKey: true })
    expect(onOpenLink).toHaveBeenCalledWith('https://example.org/', 'external')
    await editor.destroy()
  })

  it('ignores a bare click', async () => {
    const onOpenLink = vi.fn()
    const { editor, container } = await createEditor('[site](https://example.com/)', onOpenLink)
    const e = click(container.querySelector('a')!)
    expect(onOpenLink).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
    await editor.destroy()
  })
})
