/**
 * Parsing layouts and the `task_layouts` setting from disk: malformed input is
 * repaired or rejected, never thrown on; kind settings keep unknown keys.
 */
import { describe, expect, test } from 'vitest'
import { DEFAULT_PANEL_CONFIG } from '../types.js'
import type { PanelConfig } from '../types.js'
import {
  BUILTIN_LAYOUTS,
  LAYOUT_CAPABILITIES,
  builtinLayoutDefinitions,
  classicFromPanelConfig,
  isBuiltinLayoutAvailable,
  layoutFromDefinition
} from './builtins.js'
import { deriveLayoutFromLegacy } from './legacy.js'
import { isColumnVisible } from './ops.js'
import {
  defaultTaskLayoutsSetting,
  parseInstanceSettings,
  parseLayoutDefinition,
  parsePanelSizes,
  parseTaskLayout,
  parseTaskLayoutsSetting,
  serializeTaskLayout
} from './settings.js'
import type { TaskLayout } from './types.js'
import { CLASSIC_LAYOUT_ID, MAX_LAYOUT_COLUMNS, PANEL_KINDS } from './types.js'

const fresh = (): TaskLayout =>
  deriveLayoutFromLegacy(
    { panel_visibility: null, panel_sizes: null, is_temporary: false },
    DEFAULT_PANEL_CONFIG
  )

describe('kind settings', () => {
  test('unknown keys are preserved, invalid known keys dropped', () => {
    expect(parseInstanceSettings('web', { panelId: 'web:figma', zoom: 2 })).toEqual({
      panelId: 'web:figma',
      zoom: 2
    })
    expect(parseInstanceSettings('web', { panelId: 42, url: 'https://x.dev', keep: true })).toEqual(
      {
        url: 'https://x.dev',
        keep: true
      }
    )
    expect(
      parseInstanceSettings('agent', { provider: 'codex', terminalGroupIds: ['a', 3] })
    ).toEqual({
      provider: 'codex'
    })
    expect(parseInstanceSettings('artifact', { artifactId: 'a1' })).toEqual({ artifactId: 'a1' })
  })

  test('non-objects become empty settings', () => {
    for (const kind of PANEL_KINDS)
      for (const raw of [null, undefined, 'x', 3, [1, 2]])
        expect(parseInstanceSettings(kind, raw)).toEqual({})
  })
})

describe('parsePanelSizes', () => {
  test('mirrors normalizeOverrides incl. legacy {kind} shapes', () => {
    expect(
      parsePanelSizes({
        a: { unit: 'px', value: '12' },
        b: { kind: 'fixed', px: 300 },
        c: { kind: 'flex', weight: 0 },
        d: { unit: 'em', value: 1 },
        e: null
      })
    ).toEqual({
      a: { unit: 'px', value: 12 },
      b: { unit: 'px', value: 300 },
      c: { unit: 'fr', value: 1 }
    })
    expect(parsePanelSizes('nope')).toEqual({})
    expect(parsePanelSizes(null)).toEqual({})
  })
})

describe('parseTaskLayout', () => {
  test('round-trips a valid layout through JSON', () => {
    const l = fresh()
    expect(parseTaskLayout(serializeTaskLayout(l))).toEqual(l)
    expect(parseTaskLayout(JSON.parse(JSON.stringify(l)))).toEqual(l)
  })

  test('rejects what cannot be a layout', () => {
    for (const raw of [
      null,
      undefined,
      '',
      '{',
      'null',
      '[]',
      42,
      { v: 2, columns: [], instances: {} },
      { v: 1 }
    ])
      expect(parseTaskLayout(raw)).toBeNull()
  })

  test('repairs bad fields instead of failing', () => {
    const raw = {
      v: 1,
      rev: -4.5,
      layoutId: 7,
      columns: [
        {
          id: 'c1',
          size: { unit: 'banana', value: 'x' },
          sizeOverride: { unit: 'px', value: 'NaN' },
          slots: [
            {
              id: 's1',
              weight: 'heavy',
              hidden: 'yes',
              name: 5,
              activeInstanceId: 'ghost',
              tabs: [
                { instanceId: 'terminal', hidden: 1 },
                { instanceId: 'browser' },
                'junk',
                { instanceId: 'bad-kind' }
              ]
            },
            null
          ]
        },
        'junk',
        { id: 'c2', size: { unit: 'px', value: 300, align: 'right', min: 100 }, slots: [] }
      ],
      instances: {
        terminal: { id: 'terminal', kind: 'agent', settings: { provider: 'claude', extra: [1] } },
        browser: { kind: 'browser', settings: 'nope' },
        'bad-kind': { id: 'bad-kind', kind: 'teapot', settings: {} },
        unused: { id: 'unused', kind: 'editor', settings: {} }
      }
    }
    const l = parseTaskLayout(raw)!
    expect(l).not.toBeNull()
    expect(l.rev).toBe(0)
    expect(l.layoutId).toBe(CLASSIC_LAYOUT_ID)
    expect(l.columns).toHaveLength(1)
    const [c] = l.columns
    expect(c.size).toEqual({ unit: 'fr', value: 1 })
    expect(c.sizeOverride).toBeUndefined()
    expect(c.slots).toHaveLength(1)
    const [s] = c.slots
    expect(s.weight).toBe(1)
    expect(s.hidden).toBeUndefined()
    expect(s.name).toBeUndefined()
    expect(s.tabs).toEqual([{ instanceId: 'terminal' }, { instanceId: 'browser' }])
    expect(s.activeInstanceId).toBe('terminal')
    expect(Object.keys(l.instances).sort()).toEqual(['browser', 'terminal'])
    expect(l.instances.browser).toEqual({ id: 'browser', kind: 'browser', settings: {} })
    expect(l.instances.terminal.settings).toEqual({ provider: 'claude', extra: [1] })
  })

  test('fuzz: random mutations of a valid layout never throw and always yield a valid tree', () => {
    let seed = 12345
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const junk = [null, undefined, 0, -1, 1e9, Number.NaN, '', 'x', [], {}, true, [{}], { id: 3 }]
    const mutate = (v: unknown, depth: number): unknown => {
      if (rnd() < 0.08) return junk[Math.floor(rnd() * junk.length)]
      if (Array.isArray(v)) {
        const out = v.map((x) => mutate(x, depth + 1))
        if (rnd() < 0.1) out.push(junk[Math.floor(rnd() * junk.length)])
        if (rnd() < 0.1 && out.length) out.splice(Math.floor(rnd() * out.length), 1)
        if (rnd() < 0.1 && out.length) out.push(out[0])
        return out
      }
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(v)) if (rnd() > 0.05) out[k] = mutate(x, depth + 1)
        return out
      }
      return v
    }
    const base = JSON.parse(JSON.stringify(fresh()))
    for (let i = 0; i < 500; i++) {
      const l = parseTaskLayout(mutate(base, 0))
      if (!l) continue
      const seen = new Set<string>()
      for (const c of l.columns) {
        expect(c.slots.length).toBeGreaterThan(0)
        expect(['px', 'fr', 'pct']).toContain(c.size.unit)
        expect(Number.isFinite(c.size.value)).toBe(true)
        for (const s of c.slots) {
          expect(s.tabs.length).toBeGreaterThan(0)
          expect(s.weight).toBeGreaterThan(0)
          expect(s.tabs.some((t) => t.instanceId === s.activeInstanceId)).toBe(true)
          for (const t of s.tabs) {
            expect(l.instances[t.instanceId]?.id).toBe(t.instanceId)
            expect(seen.has(t.instanceId)).toBe(false)
            seen.add(t.instanceId)
          }
        }
      }
      expect(Object.keys(l.instances).sort()).toEqual([...seen].sort())
      // A repaired layout is stable.
      expect(parseTaskLayout(JSON.parse(JSON.stringify(l)))).toEqual(l)
    }
  })
})

describe('built-in layouts', () => {
  test('Classic = one column per enabled kind in panel_config.order with today’s defaults', () => {
    const config: PanelConfig = {
      ...structuredClone(DEFAULT_PANEL_CONFIG),
      viewEnabled: {
        task: { ...DEFAULT_PANEL_CONFIG.viewEnabled.task, processes: false, 'web:github': true }
      }
    }
    const classic = classicFromPanelConfig(config)
    expect(classic).toMatchObject({
      id: CLASSIC_LAYOUT_ID,
      name: 'Classic',
      builtin: true,
      enabled: true
    })
    expect(classic.columns.map((c) => c.id)).toEqual([
      'terminal',
      'browser',
      'editor',
      'artifacts',
      'diff',
      'settings',
      'web:github'
    ])
    expect(classic.columns.find((c) => c.id === 'settings')!.size).toMatchObject({
      unit: 'px',
      value: 440
    })
    expect(classic.columns.filter(isColumnVisible).map((c) => c.id)).toEqual([
      'terminal',
      'settings'
    ])
  })

  test('a task layout from Classic equals the layout derived for a fresh task', () => {
    expect(layoutFromDefinition(classicFromPanelConfig(DEFAULT_PANEL_CONFIG))).toEqual(fresh())
  })

  test('every built-in is a valid definition; only Classic-era kinds are available today', () => {
    const defs = builtinLayoutDefinitions(DEFAULT_PANEL_CONFIG)
    expect(defs.map((d) => d.id)).toEqual(BUILTIN_LAYOUTS.map((b) => b.id))
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length)
    for (const d of defs) {
      expect(d.builtin).toBe(true)
      expect(d.columns.length).toBeLessThanOrEqual(MAX_LAYOUT_COLUMNS)
      expect(parseLayoutDefinition(JSON.parse(JSON.stringify(d)))).toEqual(
        Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'available'))
      )
    }
    const available = Object.fromEntries(defs.map((d) => [d.id, d.available]))
    expect(available[CLASSIC_LAYOUT_ID]).toBe(true)
    for (const id of ['split-settings', 'two-git', 'two-agents', 'debug'])
      expect(available[id]).toBe(false)
  })

  test('availability follows capabilities', () => {
    const twoAgents = BUILTIN_LAYOUTS.find((b) => b.id === 'two-agents')!
    expect(isBuiltinLayoutAvailable(twoAgents, LAYOUT_CAPABILITIES)).toBe(false)
    expect(
      isBuiltinLayoutAvailable(twoAgents, { kinds: [...PANEL_KINDS], multiInstance: true })
    ).toBe(true)
  })
})

describe('parseTaskLayoutsSetting', () => {
  test('defaults on garbage', () => {
    for (const raw of [null, undefined, '', '{', 'null', 3, [], { v: 2 }])
      expect(parseTaskLayoutsSetting(raw)).toEqual(defaultTaskLayoutsSetting())
    expect(defaultTaskLayoutsSetting()).toEqual({
      v: 1,
      defaultLayoutId: CLASSIC_LAYOUT_ID,
      builtinOverrides: {},
      user: [],
      order: []
    })
  })

  test('keeps valid user layouts and overrides, drops broken ones and clashes', () => {
    const classic = classicFromPanelConfig(DEFAULT_PANEL_CONFIG)
    const userDef = { ...classic, id: 'u1', name: 'Mine', builtin: true, shortcutIndex: 2 }
    const raw = JSON.stringify({
      v: 1,
      defaultLayoutId: 'u1',
      builtinOverrides: {
        classic: {
          enabled: false,
          shortcutIndex: null,
          columns: classic.columns,
          instances: classic.instances
        },
        focus: { name: 7, shortcutIndex: 2 },
        nope: { enabled: true }
      },
      user: [
        userDef,
        { ...userDef, name: 'dup id' },
        { ...userDef, id: 'classic', name: 'clashes with builtin' },
        { id: 'u2', name: '', columns: 'x' },
        {
          id: 'u3',
          name: 'Empty',
          builtin: false,
          enabled: true,
          columns: [],
          instances: {},
          shortcutIndex: 2
        }
      ],
      order: ['u1', 'ghost', 'classic', 'u1', 4]
    })
    const s = parseTaskLayoutsSetting(raw)
    expect(s.defaultLayoutId).toBe('u1')
    expect(s.user.map((u) => u.id)).toEqual(['u1', 'u3'])
    expect(s.user[0].builtin).toBe(false)
    expect(s.user[0].shortcutIndex).toBe(2)
    // Shortcut 2 is taken by u1 → dropped from u3 and the focus override.
    expect(s.user[1].shortcutIndex).toBeUndefined()
    expect(s.builtinOverrides.classic).toMatchObject({ enabled: false, shortcutIndex: null })
    expect(s.builtinOverrides.classic.columns).toEqual(classic.columns)
    expect(s.builtinOverrides.focus).toEqual({})
    expect(s.builtinOverrides.nope).toBeUndefined()
    expect(s.order).toEqual(['u1', 'classic'])
  })

  test('an unknown default falls back to Classic', () => {
    expect(parseTaskLayoutsSetting({ v: 1, defaultLayoutId: 'ghost' }).defaultLayoutId).toBe(
      CLASSIC_LAYOUT_ID
    )
  })
})
