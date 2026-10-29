import { describe, expect, test } from 'vitest'
import {
  HISTORY_IDLE,
  buildPromptHistory,
  historyStep,
  isBrowsingHistory,
  searchPrompts
} from './prompt-history'

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
