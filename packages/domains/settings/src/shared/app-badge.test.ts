import { describe, expect, it } from 'vitest'
import {
  APP_BADGE_KEYS,
  appBadgeProjectKey,
  computeAppBadge,
  parseAppBadgeSettings,
  type AppBadgeSettings,
  type AppBadgeTask
} from './app-badge'

const t = (taskId: string, projectKey = 'h1:p1'): AppBadgeTask => ({ taskId, projectKey })

const settings = (over: Partial<AppBadgeSettings> = {}): AppBadgeSettings => ({
  sources: ['unread', 'idle'],
  style: 'count',
  scope: 'all',
  projects: [],
  openTabsOnly: false,
  ...over
})

describe('parseAppBadgeSettings', () => {
  it('defaults to off when nothing is saved', () => {
    expect(parseAppBadgeSettings({})).toEqual({
      sources: [],
      style: 'count',
      scope: 'all',
      projects: [],
      openTabsOnly: false
    })
  })

  it('reads saved values and drops unknown ones', () => {
    expect(
      parseAppBadgeSettings({
        [APP_BADGE_KEYS.sources]: JSON.stringify(['idle', 'bogus', 'unread', 'idle']),
        [APP_BADGE_KEYS.style]: 'separate',
        [APP_BADGE_KEYS.scope]: 'selected',
        [APP_BADGE_KEYS.projects]: JSON.stringify(['h1:p1', 42]),
        [APP_BADGE_KEYS.openTabsOnly]: 'true'
      })
    ).toEqual({
      sources: ['unread', 'idle'],
      style: 'separate',
      scope: 'selected',
      projects: ['h1:p1'],
      openTabsOnly: true
    })
  })

  it('survives malformed JSON and unknown enums', () => {
    expect(
      parseAppBadgeSettings({
        [APP_BADGE_KEYS.sources]: '{nope',
        [APP_BADGE_KEYS.style]: 'huge',
        [APP_BADGE_KEYS.scope]: 'weird',
        [APP_BADGE_KEYS.projects]: '"str"'
      })
    ).toEqual({
      sources: [],
      style: 'count',
      scope: 'all',
      projects: [],
      openTabsOnly: false
    })
  })
})

describe('appBadgeProjectKey', () => {
  it('joins hub and project id', () => {
    expect(appBadgeProjectKey('hub-a', 'proj-1')).toBe('hub-a:proj-1')
  })
})

describe('computeAppBadge', () => {
  it('is empty when no source is enabled', () => {
    expect(
      computeAppBadge(settings({ sources: [] }), { unread: [t('a')], idle: [t('b')] })
    ).toEqual({ text: '', count: 0 })
  })

  it('is empty when nothing matches', () => {
    expect(computeAppBadge(settings(), { unread: [], idle: [] })).toEqual({ text: '', count: 0 })
  })

  it('count style counts each task once across sources', () => {
    expect(
      computeAppBadge(settings(), { unread: [t('a'), t('b')], idle: [t('b'), t('c')] })
    ).toEqual({ text: '3', count: 3 })
  })

  it('only counts enabled sources', () => {
    expect(
      computeAppBadge(settings({ sources: ['idle'] }), {
        unread: [t('a'), t('b')],
        idle: [t('c')]
      })
    ).toEqual({ text: '1', count: 1 })
  })

  it('caps the text at 99+', () => {
    const many = Array.from({ length: 120 }, (_, i) => t(`t${i}`))
    expect(computeAppBadge(settings(), { unread: many, idle: [] })).toEqual({
      text: '99+',
      count: 120
    })
  })

  it('separate style shows one number per enabled source, unread first', () => {
    expect(
      computeAppBadge(settings({ style: 'separate', sources: ['idle', 'unread'] }), {
        unread: [t('a'), t('b')],
        idle: [t('b'), t('c'), t('d')]
      })
    ).toEqual({ text: '2·3', count: 4 })
  })

  it('separate style keeps a zero so positions stay stable', () => {
    expect(
      computeAppBadge(settings({ style: 'separate' }), { unread: [], idle: [t('c')] })
    ).toEqual({ text: '0·1', count: 1 })
  })

  it('separate style with one source is just that number', () => {
    expect(
      computeAppBadge(settings({ style: 'separate', sources: ['unread'] }), {
        unread: [t('a')],
        idle: [t('c')]
      })
    ).toEqual({ text: '1', count: 1 })
  })

  it('dot style shows a dot, no number', () => {
    expect(
      computeAppBadge(settings({ style: 'dot' }), { unread: [t('a')], idle: [t('b')] })
    ).toEqual({ text: '•', count: 2 })
  })

  it('selected scope only counts chosen projects', () => {
    expect(
      computeAppBadge(settings({ scope: 'selected', projects: ['h1:p2'] }), {
        unread: [t('a', 'h1:p1'), t('b', 'h1:p2')],
        idle: [t('c', 'h2:p2')]
      })
    ).toEqual({ text: '1', count: 1 })
  })

  it('selected scope with no projects chosen shows nothing', () => {
    expect(
      computeAppBadge(settings({ scope: 'selected', projects: [] }), {
        unread: [t('a')],
        idle: [t('b')]
      })
    ).toEqual({ text: '', count: 0 })
  })

  it('open-tabs-only counts just the tasks open as tabs', () => {
    expect(
      computeAppBadge(
        settings({ openTabsOnly: true }),
        { unread: [t('a'), t('b')], idle: [t('c')] },
        new Set(['b', 'c'])
      )
    ).toEqual({ text: '2', count: 2 })
  })

  it('open-tabs-only off ignores the open set', () => {
    expect(
      computeAppBadge(settings(), { unread: [t('a'), t('b')], idle: [] }, new Set(['b']))
    ).toEqual({ text: '2', count: 2 })
  })
})
