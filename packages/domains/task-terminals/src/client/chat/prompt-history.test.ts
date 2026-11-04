import { describe, expect, test } from 'vitest'
import {
  HISTORY_IDLE,
  buildPromptHistory,
  historyStep,
  historyStepAttachments,
  isBrowsingHistory,
  recordedAttachments,
  searchPrompts
} from './prompt-history'
import type { ChatAttachment } from '@slayzone/terminal-contracts'

const file = (artifactId: string): ChatAttachment => ({
  artifactId,
  name: `${artifactId}.png`,
  kind: 'image',
  mediaType: 'image/png',
  size: 10
})

describe('buildPromptHistory', () => {
  test('newest first: this session’s sends, then stored prompts (stored oldest first)', () => {
    expect(buildPromptHistory(['typed now'], ['oldest', 'older'])).toEqual([
      'typed now',
      'older',
      'oldest'
    ])
  })

  test('duplicates keep their most recent position; blank + synthetic texts are skipped', () => {
    expect(buildPromptHistory(['b'], ['a', 'b', '  ', '__slay_plan_approved__', 'c', 'a'])).toEqual(
      ['b', 'a', 'c']
    )
  })
})

describe('historyStep', () => {
  const entries = ['third', 'second', 'first']

  test('↑ on an empty composer recalls the newest prompt', () => {
    expect(
      historyStep({ nav: HISTORY_IDLE, key: 'up', draft: '', caretAtStart: true, entries })
    ).toEqual({ nav: { index: 0, stash: '' }, draft: 'third' })
  })

  test('↑ with the caret at the start stashes the draft; ↓ past the newest restores it', () => {
    const up = historyStep({
      nav: HISTORY_IDLE,
      key: 'up',
      draft: 'half typed',
      caretAtStart: true,
      entries
    })
    expect(up).toEqual({ nav: { index: 0, stash: 'half typed' }, draft: 'third' })
    const down = historyStep({
      nav: up!.nav,
      key: 'down',
      draft: up!.draft,
      caretAtStart: false,
      entries
    })
    expect(down).toEqual({ nav: HISTORY_IDLE, draft: 'half typed' })
  })

  test('while browsing, ↑/↓ walk the history wherever the caret is', () => {
    const nav = { index: 0, stash: '' }
    const older = historyStep({ nav, key: 'up', draft: 'third', caretAtStart: false, entries })
    expect(older).toEqual({ nav: { index: 1, stash: '' }, draft: 'second' })
    const newer = historyStep({
      nav: older!.nav,
      key: 'down',
      draft: 'second',
      caretAtStart: false,
      entries
    })
    expect(newer).toEqual({ nav: { index: 0, stash: '' }, draft: 'third' })
  })

  test('↑ at the oldest entry is consumed without change', () => {
    const nav = { index: 2, stash: '' }
    expect(historyStep({ nav, key: 'up', draft: 'first', caretAtStart: false, entries })).toEqual({
      nav,
      draft: 'first'
    })
  })

  test('the native caret move wins when not browsing and the caret is not at the start', () => {
    expect(
      historyStep({ nav: HISTORY_IDLE, key: 'up', draft: 'abc', caretAtStart: false, entries })
    ).toBeNull()
    expect(
      historyStep({ nav: HISTORY_IDLE, key: 'down', draft: '', caretAtStart: true, entries })
    ).toBeNull()
  })

  test('editing a recalled prompt ends browsing', () => {
    const nav = { index: 0, stash: '' }
    expect(isBrowsingHistory(nav, 'third', entries)).toBe(true)
    expect(isBrowsingHistory(nav, 'third!', entries)).toBe(false)
    expect(
      historyStep({ nav, key: 'up', draft: 'third!', caretAtStart: false, entries })
    ).toBeNull()
  })

  test('no history → nothing to recall', () => {
    expect(
      historyStep({ nav: HISTORY_IDLE, key: 'up', draft: '', caretAtStart: true, entries: [] })
    ).toBeNull()
  })
})

describe('searchPrompts', () => {
  test('case-insensitive substring, newest first; empty query lists everything', () => {
    const entries = ['Fix the AUTH bug', 'add tests', 'auth: refresh tokens']
    expect(searchPrompts(entries, 'auth')).toEqual(['Fix the AUTH bug', 'auth: refresh tokens'])
    expect(searchPrompts(entries, '')).toEqual(entries)
  })
})

describe('recordedAttachments', () => {
  test('the files saved with the newest record of that text; none → null', () => {
    const records = [
      { text: 'cleared', attachments: [file('new')] },
      { text: 'sent', attachments: [] },
      { text: 'cleared', attachments: [file('old')] }
    ]
    expect(recordedAttachments(records, 'cleared')).toEqual([file('new')])
    expect(recordedAttachments(records, 'sent')).toBeNull()
    expect(recordedAttachments(records, 'never')).toBeNull()
  })
})

describe('historyStepAttachments', () => {
  const saved = { 'with files': [file('a')] } as Record<string, ChatAttachment[]>
  const attachmentsOf = (text: string) => saved[text] ?? null
  const current = [file('current')]
  const stash = [file('stash')]
  const step = (leaving: string | null, arriving: string | null) =>
    historyStepAttachments({ leaving, arriving, current, stash, attachmentsOf })

  test('an entry saved with files brings them back', () => {
    expect(step(null, 'with files')).toEqual([file('a')])
    expect(step('plain', 'with files')).toEqual([file('a')])
  })

  test('leaving it brings back the files the composer held when browsing started', () => {
    expect(step('with files', 'plain')).toEqual(stash)
    expect(step('with files', null)).toEqual(stash)
  })

  test('between plain entries the composer files stay as they are', () => {
    expect(step(null, 'plain')).toBe(current)
    expect(step('plain', 'older plain')).toBe(current)
    expect(step('plain', null)).toBe(current)
  })
})
