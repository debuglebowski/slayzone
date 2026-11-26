/**
 * Step 12 kinds (docs/plans/panel-model.md): web page settings and URLs, Artifact
 * panels, one-per-task kinds — their settings parse and how adding finds an
 * existing instance.
 */
import { describe, expect, test } from 'vitest'
import { switchLayout } from './definitions.js'
import {
  artifactIdOf,
  existingInstanceFor,
  isWebPageInstance,
  normalizeWebPageUrl,
  webPageLabel,
  webPageSettings,
  webPageUrlOf
} from './kinds.js'
import { addInstance } from './ops.js'
import { parseInstanceSettings, parseTaskLayout } from './settings.js'
import type { LayoutDefinition, PanelInstance, TaskLayout } from './types.js'

const ids = (): (() => string) => {
  let n = 0
  return () => `${++n}`.padStart(8, '0')
}

function base(): TaskLayout {
  return {
    v: 1,
    rev: 0,
    layoutId: 'classic',
    instances: { terminal: { id: 'terminal', kind: 'agent', settings: {} } },
    columns: [
      {
        id: 'terminal',
        size: { unit: 'fr', value: 1 },
        slots: [
          {
            id: 'terminal',
            weight: 1,
            activeInstanceId: 'terminal',
            tabs: [{ instanceId: 'terminal' }]
          }
        ]
      }
    ]
  }
}

describe('settings parse', () => {
  test('web page: url kept (empty = not set up); a bad url type is dropped', () => {
    expect(parseInstanceSettings('web', { url: 'https://a.dev/' })).toEqual({
      url: 'https://a.dev/'
    })
    expect(parseInstanceSettings('web', { url: '' })).toEqual({ url: '' })
    expect(parseInstanceSettings('web', { url: 42, extra: 1 })).toEqual({ extra: 1 })
  })

  test('artifact: artifactId kept, junk dropped, unknown keys kept', () => {
    expect(parseInstanceSettings('artifact', { artifactId: 'a1', x: true })).toEqual({
      artifactId: 'a1',
      x: true
    })
    expect(parseInstanceSettings('artifact', { artifactId: ['a1'] })).toEqual({})
  })

  test('description / subtasks / details take no settings but keep unknown keys', () => {
    for (const kind of ['description', 'subtasks', 'details'] as const)
      expect(parseInstanceSettings(kind, { later: 1 })).toEqual({ later: 1 })
  })

  test('a stored layout with the new kinds survives the parser', () => {
    const layout = addInstance(
      base(),
      'artifact',
      { type: 'column' },
      {
        settings: { artifactId: 'a1' },
        newId: ids()
      }
    ).layout
    const withPage = addInstance(
      layout,
      'web',
      { type: 'column' },
      {
        settings: webPageSettings('https://grafana.example.com/d/hub'),
        newId: ids()
      }
    ).layout
    const parsed = parseTaskLayout(JSON.stringify(withPage))
    expect(parsed?.instances['artifact:00000001']).toEqual({
      id: 'artifact:00000001',
      kind: 'artifact',
      settings: { artifactId: 'a1' }
    })
    expect(webPageUrlOf(parsed?.instances['web:00000001'])).toBe(
      'https://grafana.example.com/d/hub'
    )
  })
})

describe('web pages', () => {
  const page = (settings: Record<string, unknown>): PanelInstance => ({
    id: 'web:1',
    kind: 'web',
    settings
  })

  test('a web page has url; a configured web panel has panelId', () => {
    expect(isWebPageInstance(page({ url: '' }))).toBe(true)
    expect(isWebPageInstance(page({ panelId: 'web:figma' }))).toBe(false)
    expect(isWebPageInstance({ id: 'browser', kind: 'browser', settings: { url: 'x' } })).toBe(
      false
    )
    expect(webPageUrlOf(page({ url: '' }))).toBeNull()
    expect(webPageUrlOf(page({ url: 'https://a.dev/' }))).toBe('https://a.dev/')
  })

  test('a new web page is created through addInstance with a <kind>:<uuid8> id, never a web panel id', () => {
    const { layout, instanceId } = addInstance(
      base(),
      'web',
      { type: 'column' },
      {
        settings: webPageSettings(),
        newId: ids()
      }
    )
    expect(instanceId).toBe('web:00000001')
    expect(layout.instances[instanceId].settings).toEqual({ url: '' })
  })

  test('normalizeWebPageUrl', () => {
    expect(normalizeWebPageUrl('example.com/x')).toBe('https://example.com/x')
    expect(normalizeWebPageUrl('  https://a.dev ')).toBe('https://a.dev/')
    expect(normalizeWebPageUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeWebPageUrl('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app')
    expect(normalizeWebPageUrl('intranet:8080')).toBe('https://intranet:8080/')
    expect(normalizeWebPageUrl('http://grafana/d')).toBe('http://grafana/d')
    expect(normalizeWebPageUrl('file:///tmp/report.html')).toBe('file:///tmp/report.html')
    for (const bad of ['', '   ', 'hello', 'two words.com', 'javascript:alert(1)', 'mailto:a@b.c'])
      expect(normalizeWebPageUrl(bad)).toBeNull()
  })

  test('webPageLabel is the host', () => {
    expect(webPageLabel('https://grafana.example.com/d/hub')).toBe('grafana.example.com')
    expect(webPageLabel('http://localhost:3000/')).toBe('localhost:3000')
    expect(webPageLabel('file:///tmp/report.html')).toBe('report.html')
  })
})

describe('adding finds an existing instance', () => {
  test('one-per-task kinds: the instance the task has', () => {
    const { layout, instanceId } = addInstance(
      base(),
      'description',
      { type: 'column' },
      {
        newId: ids()
      }
    )
    expect(existingInstanceFor(layout, 'description')).toBe(instanceId)
    expect(existingInstanceFor(layout, 'subtasks')).toBeNull()
    expect(existingInstanceFor(base(), 'settings')).toBeNull()
  })

  test('artifact: the panel showing the same artifact only', () => {
    const { layout, instanceId } = addInstance(
      base(),
      'artifact',
      { type: 'column' },
      {
        settings: { artifactId: 'a1' },
        newId: ids()
      }
    )
    expect(artifactIdOf(layout.instances[instanceId])).toBe('a1')
    expect(existingInstanceFor(layout, 'artifact', { artifactId: 'a1' })).toBe(instanceId)
    expect(existingInstanceFor(layout, 'artifact', { artifactId: 'a2' })).toBeNull()
    expect(existingInstanceFor(layout, 'artifact', {})).toBeNull()
  })

  test('multi-instance kinds always add', () => {
    expect(existingInstanceFor(base(), 'agent')).toBeNull()
    expect(existingInstanceFor(base(), 'web', webPageSettings('https://a.dev/'))).toBeNull()
  })
})

describe('layout switch', () => {
  test('Artifact panels match by artifact, not just by kind', () => {
    let current = addInstance(
      base(),
      'artifact',
      { type: 'column' },
      {
        settings: { artifactId: 'a1' },
        newId: ids()
      }
    ).layout
    current = addInstance(
      current,
      'artifact',
      { type: 'column' },
      {
        settings: { artifactId: 'a2' },
        newId: () => 'bbbbbbbb'
      }
    ).layout
    const def: LayoutDefinition = {
      id: 'mine',
      name: 'Mine',
      builtin: false,
      enabled: true,
      instances: {
        terminal: { id: 'terminal', kind: 'agent', settings: {} },
        'artifact:x': { id: 'artifact:x', kind: 'artifact', settings: { artifactId: 'a2' } }
      },
      columns: base().columns.concat({
        id: 'artifact:x',
        size: { unit: 'fr', value: 1 },
        slots: [
          {
            id: 'artifact:x',
            weight: 1,
            activeInstanceId: 'artifact:x',
            tabs: [{ instanceId: 'artifact:x' }]
          }
        ]
      })
    }
    const result = switchLayout(current, def, { hasLiveState: () => false })
    expect(Object.keys(result.layout.instances).sort()).toEqual(['artifact:bbbbbbbb', 'terminal'])
    expect(result.dropped.map((i) => i.id)).toEqual(['artifact:00000001'])
  })
})
