import { describe, expect, it, vi } from 'vitest'
import { classifyChatLink, openChatLink, resolveIdRef, type ChatLinkClick } from './chat-link'

function actionsSpy() {
  return {
    cwd: '/repo',
    openThread: vi.fn(),
    openFile: vi.fn(),
    openArtifact: vi.fn(),
    openTask: vi.fn(),
    openUrl: vi.fn(),
    openExternal: vi.fn()
  }
}
const click = (href: string, extra: Partial<ChatLinkClick> = {}): ChatLinkClick => ({
  href,
  mod: false,
  shift: false,
  ...extra
})

describe('openChatLink', () => {
  it('opens an absolute file path at its line in the editor', () => {
    const a = actionsSpy()
    openChatLink(click('/Users/me/exec-proxies.ts:105'), a)
    expect(a.openFile).toHaveBeenCalledWith('/Users/me/exec-proxies.ts', 105, undefined)
  })

  it('resolves a relative path against the chat cwd', () => {
    const a = actionsSpy()
    openChatLink(click('packages/x.ts#L7C2'), a)
    expect(a.openFile).toHaveBeenCalledWith('/repo/packages/x.ts', 7, 2)
  })

  it('opens artifacts and tasks in-app', () => {
    const a = actionsSpy()
    openChatLink(click('artifact:416b87b4'), a)
    openChatLink(click('slayzone://task/3ad62499'), a)
    expect(a.openArtifact).toHaveBeenCalledWith('416b87b4')
    expect(a.openTask).toHaveBeenCalledWith('3ad62499')
  })

  it('web links: bare and ⌘⇧ → external, ⌘ → in-app browser', () => {
    const a = actionsSpy()
    openChatLink(click('https://x.dev'), a)
    openChatLink(click('https://x.dev', { mod: true, shift: true }), a)
    openChatLink(click('https://y.dev', { mod: true }), a)
    expect(a.openExternal.mock.calls).toEqual([['https://x.dev'], ['https://x.dev']])
    expect(a.openUrl).toHaveBeenCalledWith('https://y.dev')
  })

  it('opens threads', () => {
    const a = actionsSpy()
    openChatLink(click('#chat-thread:t1'), a)
    expect(a.openThread).toHaveBeenCalledWith('t1')
  })

  it('a Codex citation chip opens its local file', () => {
    const a = actionsSpy()
    openChatLink(click('docs/a.md', { citedPath: 'docs/a.md' }), a)
    expect(a.openFile).toHaveBeenCalledWith('/repo/docs/a.md')
  })

  it('a site-relative link in a fetched page summary resolves against that page', () => {
    const a = actionsSpy()
    openChatLink(click('/en/guide', { base: 'https://x.dev/docs/page' }), a)
    openChatLink(click('next.html', { base: 'https://x.dev/docs/page' }), a)
    expect(a.openExternal.mock.calls).toEqual([
      ['https://x.dev/en/guide'],
      ['https://x.dev/docs/next.html']
    ])
    expect(a.openFile).not.toHaveBeenCalled()
  })

  it('opens nothing for blank or unknown links', () => {
    const a = actionsSpy()
    openChatLink(click(''), a)
    openChatLink(click('figma://x'), a)
    for (const fn of Object.values(a))
      if (typeof fn === 'function') expect(fn).not.toHaveBeenCalled()
  })
})

describe('classifyChatLink', () => {
  it('routes thread anchors', () => {
    expect(classifyChatLink('#chat-thread:t1')).toEqual({ kind: 'thread', id: 't1' })
  })

  it('routes web and mail links', () => {
    expect(classifyChatLink('https://x.dev/a')).toEqual({ kind: 'web', url: 'https://x.dev/a' })
    expect(classifyChatLink('HTTP://x.dev')).toEqual({ kind: 'web', url: 'HTTP://x.dev' })
    expect(classifyChatLink('mailto:a@b.c')).toEqual({ kind: 'external', url: 'mailto:a@b.c' })
  })

  it('routes artifact links, full id or short prefix', () => {
    expect(classifyChatLink('artifact:6a297ef2-d4e5-4cb4')).toEqual({
      kind: 'artifact',
      ref: '6a297ef2-d4e5-4cb4'
    })
    expect(classifyChatLink('artifact:416b87b4')).toEqual({ kind: 'artifact', ref: '416b87b4' })
  })

  it('routes task deep links', () => {
    expect(classifyChatLink('slayzone://task/3ad62499')).toEqual({ kind: 'task', ref: '3ad62499' })
    expect(classifyChatLink('slayzone://task/f4b6d6ad-fd7b/')).toEqual({
      kind: 'task',
      ref: 'f4b6d6ad-fd7b'
    })
  })

  it('routes absolute paths with a line (and column) suffix', () => {
    expect(classifyChatLink('/Users/me/a/exec-proxies.ts:105')).toEqual({
      kind: 'file',
      path: '/Users/me/a/exec-proxies.ts',
      line: 105
    })
    expect(classifyChatLink('/Users/me/a.ts:105:7')).toEqual({
      kind: 'file',
      path: '/Users/me/a.ts',
      line: 105,
      col: 7
    })
  })

  it('routes GitHub-style #L anchors', () => {
    expect(classifyChatLink('/Users/me/a.ts#L42')).toEqual({
      kind: 'file',
      path: '/Users/me/a.ts',
      line: 42
    })
    expect(classifyChatLink('src/a.ts#L42-L50')).toEqual({
      kind: 'file',
      path: 'src/a.ts',
      line: 42
    })
    expect(classifyChatLink('src/a.ts#L42C3')).toEqual({
      kind: 'file',
      path: 'src/a.ts',
      line: 42,
      col: 3
    })
  })

  it('routes relative and bare paths, with or without a line', () => {
    expect(classifyChatLink('packages/x/y.ts:12')).toEqual({
      kind: 'file',
      path: 'packages/x/y.ts',
      line: 12
    })
    expect(classifyChatLink('exec-proxies.ts:105')).toEqual({
      kind: 'file',
      path: 'exec-proxies.ts',
      line: 105
    })
    expect(classifyChatLink('../fu-1.review-1.md')).toEqual({
      kind: 'file',
      path: '../fu-1.review-1.md'
    })
    expect(classifyChatLink('/Users/me/notes.md')).toEqual({
      kind: 'file',
      path: '/Users/me/notes.md'
    })
  })

  it('decodes percent-encoded paths', () => {
    expect(classifyChatLink('/Users/me/My%20Notes.md')).toEqual({
      kind: 'file',
      path: '/Users/me/My Notes.md'
    })
  })

  it('routes file:// URLs', () => {
    expect(classifyChatLink('file:///Users/me/a%20b.ts')).toEqual({
      kind: 'file',
      path: '/Users/me/a b.ts'
    })
    expect(classifyChatLink('file:///Users/me/a.ts#L9')).toEqual({
      kind: 'file',
      path: '/Users/me/a.ts',
      line: 9
    })
  })

  it('opens nothing for empty, in-page, unknown-scheme or malformed links', () => {
    for (const href of [
      '',
      '#section',
      'figma://file/x',
      'javascript:alert(1)',
      'artifact:',
      'slayzone://task/',
      'slayzone://auth/callback'
    ])
      expect(classifyChatLink(href)).toEqual({ kind: 'none' })
  })
})

describe('resolveIdRef', () => {
  const ids = ['3ad62499-aaaa', '3ad6f000-bbbb', 'f4b6d6ad-cccc']

  it('returns an exact id', () => {
    expect(resolveIdRef('f4b6d6ad-cccc', ids)).toBe('f4b6d6ad-cccc')
  })

  it('expands a unique prefix', () => {
    expect(resolveIdRef('3ad62499', ids)).toBe('3ad62499-aaaa')
  })

  it('an exact id wins over other ids it prefixes, in any order', () => {
    expect(resolveIdRef('ab', ['abc', 'abd', 'ab'])).toBe('ab')
  })

  it('returns null for an ambiguous or unknown prefix', () => {
    expect(resolveIdRef('3ad6', ids)).toBeNull()
    expect(resolveIdRef('ffff', ids)).toBeNull()
    expect(resolveIdRef('', ids)).toBeNull()
  })
})
