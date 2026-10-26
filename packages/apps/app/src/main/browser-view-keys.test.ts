import { describe, expect, it } from 'vitest'
import { classifyBrowserViewKey } from './browser-view-keys'

const key = (
  k: string,
  mods: { meta?: boolean; control?: boolean; shift?: boolean; alt?: boolean } = {}
) => ({
  key: k,
  meta: false,
  control: false,
  shift: false,
  alt: false,
  ...mods
})

describe('classifyBrowserViewKey — macOS (primary = Cmd)', () => {
  it('ignores keys without Cmd/Ctrl', () => {
    expect(classifyBrowserViewKey(key('c'), 'mac')).toEqual({ kind: 'ignore' })
    expect(classifyBrowserViewKey(key('r', { shift: true }), 'mac')).toEqual({ kind: 'ignore' })
  })

  it('passes native edit/scroll combos through to the page', () => {
    for (const k of ['c', 'v', 'x', 'a', 'z', 'ArrowUp', 'ArrowDown']) {
      expect(classifyBrowserViewKey(key(k, { meta: true }), 'mac')).toEqual({ kind: 'passthrough' })
    }
    expect(classifyBrowserViewKey(key('z', { meta: true, shift: true }), 'mac')).toEqual({
      kind: 'passthrough'
    })
  })

  it('handles the main-process keys', () => {
    expect(classifyBrowserViewKey(key('r', { meta: true }), 'mac')).toEqual({ kind: 'reload-view' })
    expect(classifyBrowserViewKey(key('r', { meta: true, shift: true }), 'mac')).toEqual({
      kind: 'menu',
      event: 'reload-app'
    })
    expect(classifyBrowserViewKey(key(',', { meta: true }), 'mac')).toEqual({
      kind: 'menu',
      event: 'open-settings'
    })
    expect(classifyBrowserViewKey(key(',', { meta: true, shift: true }), 'mac')).toEqual({
      kind: 'menu',
      event: 'open-project-settings'
    })
    expect(classifyBrowserViewKey(key('s', { meta: true, shift: true }), 'mac')).toEqual({
      kind: 'menu',
      event: 'screenshot-trigger'
    })
    expect(classifyBrowserViewKey(key('§', { meta: true }), 'mac')).toEqual({
      kind: 'menu',
      event: 'go-home'
    })
  })

  it('forwards Ctrl combos and every other Cmd combo to the renderer', () => {
    expect(classifyBrowserViewKey(key('c', { control: true }), 'mac')).toEqual({ kind: 'forward' })
    expect(classifyBrowserViewKey(key('r', { control: true }), 'mac')).toEqual({ kind: 'forward' })
    expect(classifyBrowserViewKey(key('Tab', { control: true }), 'mac')).toEqual({
      kind: 'forward'
    })
    expect(classifyBrowserViewKey(key('b', { meta: true }), 'mac')).toEqual({ kind: 'forward' })
    expect(classifyBrowserViewKey(key('c', { meta: true, alt: true }), 'mac')).toEqual({
      kind: 'forward'
    })
  })
})

describe('classifyBrowserViewKey — Windows/Linux (primary = Ctrl)', () => {
  it('passes Ctrl+C/V/X/A/Z through to the page instead of swallowing them', () => {
    for (const k of ['c', 'v', 'x', 'a', 'z', 'ArrowUp', 'ArrowDown']) {
      expect(classifyBrowserViewKey(key(k, { control: true }), 'other')).toEqual({
        kind: 'passthrough'
      })
    }
  })

  it('handles the main-process keys on Ctrl', () => {
    expect(classifyBrowserViewKey(key('r', { control: true }), 'other')).toEqual({
      kind: 'reload-view'
    })
    expect(classifyBrowserViewKey(key('r', { control: true, shift: true }), 'other')).toEqual({
      kind: 'menu',
      event: 'reload-app'
    })
    expect(classifyBrowserViewKey(key(',', { control: true }), 'other')).toEqual({
      kind: 'menu',
      event: 'open-settings'
    })
  })

  it('does not treat Win/Super (meta) as primary — forwards it, never passes or reloads', () => {
    expect(classifyBrowserViewKey(key('c', { meta: true }), 'other')).toEqual({ kind: 'forward' })
    expect(classifyBrowserViewKey(key('r', { meta: true }), 'other')).toEqual({ kind: 'forward' })
    expect(classifyBrowserViewKey(key('r', { meta: true, control: true }), 'other')).toEqual({
      kind: 'forward'
    })
  })
})
