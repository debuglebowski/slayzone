/**
 * CLI panels command tests
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/cli/test/panels.test.ts
 */
import { afterAll, describe, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter, captureAllAsync } from './test-harness.js'
import type { PanelConfig, WebPanelDefinition } from '../../../domains/task/src/shared/types.js'
import {
  DEFAULT_PANEL_CONFIG,
  PREDEFINED_WEB_PANELS,
  isPanelEnabled
} from '../../../domains/task/src/shared/types.js'
import {
  mergePredefinedWebPanels,
  validatePanelShortcut
} from '../../../domains/task/src/shared/panel-config.js'
import {
  normalizeDesktopProtocol,
  inferProtocolFromUrl,
  inferHostScopeFromUrl
} from '../../../domains/task/src/shared/handoff.js'

const h = await createTestHarness()
afterAll(() => h.cleanup())
const db = createSlayDbAdapter(h.db)

// --- helpers ---

function loadPanelConfig(): PanelConfig {
  const row = db.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'panel_config' LIMIT 1`
  )
  if (!row[0]?.value) return { ...DEFAULT_PANEL_CONFIG }
  return mergePredefinedWebPanels(JSON.parse(row[0].value) as PanelConfig)
}

function savePanelConfig(config: PanelConfig) {
  db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)`, {
    ':key': 'panel_config',
    ':value': JSON.stringify(config)
  })
}

function createPanel(
  name: string,
  rawUrl: string,
  opts: { shortcut?: string; blockHandoff?: boolean; protocol?: string } = {}
): WebPanelDefinition {
  const config = loadPanelConfig()

  let url = rawUrl.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`

  const newPanel: WebPanelDefinition = {
    id: `web:${crypto.randomUUID().slice(0, 8)}`,
    name: name.trim(),
    baseUrl: url,
    shortcut: opts.shortcut?.trim().toLowerCase() || undefined,
    blockDesktopHandoff: opts.blockHandoff || undefined,
    handoffProtocol: opts.blockHandoff
      ? (normalizeDesktopProtocol(opts.protocol ?? null) ?? inferProtocolFromUrl(url) ?? undefined)
      : undefined,
    handoffHostScope: opts.blockHandoff ? (inferHostScopeFromUrl(url) ?? undefined) : undefined
  }

  savePanelConfig({ ...config, webPanels: [...config.webPanels, newPanel] })
  return newPanel
}

// --- validatePanelShortcut ---

describe('validatePanelShortcut', () => {
  test('returns null for empty string', () => {
    expect(validatePanelShortcut('', [])).toBe(null)
  })

  test('rejects multi-character input', () => {
    expect(validatePanelShortcut('ab', [])).toBe('Must be a single letter')
  })

  test('rejects non-letter', () => {
    expect(validatePanelShortcut('1', [])).toBe('Must be a single letter')
  })

  test('rejects reserved shortcuts', () => {
    for (const key of ['k', 'b', 'e', 'g', 's']) {
      const err = validatePanelShortcut(key, [])
      expect(err !== null && err.includes('reserved for a built-in panel')).toBeTruthy()
    }
  })

  test('rejects duplicate shortcut', () => {
    const panels: WebPanelDefinition[] = [
      { id: 'web:test', name: 'Test', baseUrl: 'https://test.com', shortcut: 'a' }
    ]
    const err = validatePanelShortcut('a', panels)
    expect(err !== null && err.includes('already used by Test')).toBeTruthy()
  })

  test('allows duplicate when excludeId matches', () => {
    const panels: WebPanelDefinition[] = [
      { id: 'web:test', name: 'Test', baseUrl: 'https://test.com', shortcut: 'a' }
    ]
    expect(validatePanelShortcut('a', panels, 'web:test')).toBe(null)
  })

  test('allows valid unused shortcut', () => {
    expect(validatePanelShortcut('z', [])).toBe(null)
  })
})

// --- panels create ---

describe('panels create', () => {
  test('creates panel with name and URL', () => {
    const panel = createPanel('Linear', 'https://linear.app')
    const config = loadPanelConfig()
    const found = config.webPanels.find((p) => p.id === panel.id)
    expect(found !== undefined).toBeTruthy()
    expect(found!.name).toBe('Linear')
    expect(found!.baseUrl).toBe('https://linear.app')
  })

  test('normalizes URL without protocol', () => {
    const panel = createPanel('Example', 'example.com')
    const config = loadPanelConfig()
    const found = config.webPanels.find((p) => p.id === panel.id)
    expect(found!.baseUrl).toBe('https://example.com')
  })

  test('preserves http:// URL', () => {
    const panel = createPanel('Local', 'http://localhost:3000')
    const config = loadPanelConfig()
    const found = config.webPanels.find((p) => p.id === panel.id)
    expect(found!.baseUrl).toBe('http://localhost:3000')
  })

  test('stores shortcut as lowercase', () => {
    const panel = createPanel('Shortcut Test', 'https://test.com', { shortcut: 'Z' })
    const config = loadPanelConfig()
    const found = config.webPanels.find((p) => p.id === panel.id)
    expect(found!.shortcut).toBe('z')
  })

  test('generates web:<uuid> id', () => {
    const panel = createPanel('ID Test', 'https://test.com')
    expect(panel.id.startsWith('web:')).toBeTruthy()
    expect(panel.id.length).toBe(12) // 'web:' + 8 hex chars
  })

  test('creates with block-handoff', () => {
    const panel = createPanel('Figma Clone', 'https://figma-clone.com', { blockHandoff: true })
    const config = loadPanelConfig()
    const found = config.webPanels.find((p) => p.id === panel.id)
    expect(found!.blockDesktopHandoff).toBe(true)
    expect(found!.handoffProtocol).toBe('figma-clone')
    expect(found!.handoffHostScope).toBe('figma-clone.com')
  })

  test('creates with explicit protocol', () => {
    const panel = createPanel('Custom Proto', 'https://app.custom.io', {
      blockHandoff: true,
      protocol: 'myproto'
    })
    const config = loadPanelConfig()
    const found = config.webPanels.find((p) => p.id === panel.id)
    expect(found!.handoffProtocol).toBe('myproto')
  })

  test('preserves existing panels', () => {
    const before = loadPanelConfig().webPanels.length
    createPanel('Another', 'https://another.com')
    const after = loadPanelConfig().webPanels.length
    expect(after).toBe(before + 1)
  })
})

// --- panels list ---

describe('panels list', () => {
  test('returns all panels from config', () => {
    const config = loadPanelConfig()
    expect(config.webPanels.length).toBeGreaterThan(PREDEFINED_WEB_PANELS.length)
  })

  test('includes predefined panels', () => {
    const config = loadPanelConfig()
    const ids = config.webPanels.map((p) => p.id)
    expect(ids).toContain('web:figma')
    expect(ids).toContain('web:notion')
  })
})

// --- helpers for delete/enable/disable ---

function deletePanel(config: PanelConfig, idOrName: string): PanelConfig | null {
  const wp = config.webPanels.find(
    (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase()
  )
  if (!wp) return null
  const next: PanelConfig = { ...config, webPanels: config.webPanels.filter((p) => p.id !== wp.id) }
  if (wp.predefined) next.deletedPredefined = [...(config.deletedPredefined ?? []), wp.id]
  return next
}

function togglePanel(config: PanelConfig, idOrName: string, enabled: boolean): PanelConfig | null {
  const wp = config.webPanels.find(
    (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase()
  )
  if (!wp) return null
  return {
    ...config,
    viewEnabled: { ...config.viewEnabled, task: { ...config.viewEnabled?.task, [wp.id]: enabled } }
  }
}

// --- panels delete ---

describe('panels delete', () => {
  test('deletes custom panel by id', () => {
    const panel = createPanel('DeleteMe', 'https://delete.test')
    const config = loadPanelConfig()
    expect(config.webPanels.some((p) => p.id === panel.id)).toBeTruthy()

    const next = deletePanel(config, panel.id)!
    savePanelConfig(next)
    const after = loadPanelConfig()
    expect(after.webPanels.some((p) => p.id === panel.id)).toBe(false)
  })

  test('deletes custom panel by name (case-insensitive)', () => {
    const panel = createPanel('CaseTest', 'https://case.test')
    const config = loadPanelConfig()

    const next = deletePanel(config, 'casetest')!
    savePanelConfig(next)
    const after = loadPanelConfig()
    expect(after.webPanels.some((p) => p.id === panel.id)).toBe(false)
  })

  test('deletes predefined panel and adds to deletedPredefined', () => {
    const config = loadPanelConfig()
    expect(config.webPanels.some((p) => p.id === 'web:excalidraw')).toBeTruthy()

    const next = deletePanel(config, 'web:excalidraw')!
    savePanelConfig(next)
    const after = loadPanelConfig()
    expect(after.deletedPredefined).toContain('web:excalidraw')
    // mergePredefinedWebPanels should NOT re-add it
    expect(after.webPanels.some((p) => p.id === 'web:excalidraw')).toBe(false)
  })

  test('returns null for unknown panel', () => {
    const config = loadPanelConfig()
    expect(deletePanel(config, 'nonexistent')).toBe(null)
  })
})

// --- panels enable/disable ---

describe('panels enable/disable', () => {
  test('disable sets viewEnabled.task to false', () => {
    const panel = createPanel('ToggleTest', 'https://toggle.test')
    const config = loadPanelConfig()
    expect(isPanelEnabled(config, panel.id, 'task')).toBe(true)

    const next = togglePanel(config, panel.id, false)!
    savePanelConfig(next)
    const after = loadPanelConfig()
    expect(isPanelEnabled(after, panel.id, 'task')).toBe(false)
  })

  test('enable sets viewEnabled.task to true', () => {
    const panel = createPanel('EnableTest', 'https://enable.test')
    // First disable
    let config = loadPanelConfig()
    savePanelConfig(togglePanel(config, panel.id, false)!)
    config = loadPanelConfig()
    expect(isPanelEnabled(config, panel.id, 'task')).toBe(false)

    // Then enable
    savePanelConfig(togglePanel(config, panel.id, true)!)
    const after = loadPanelConfig()
    expect(isPanelEnabled(after, panel.id, 'task')).toBe(true)
  })

  test('lookup by name works', () => {
    const panel = createPanel('NameLookup', 'https://name.test')
    const config = loadPanelConfig()
    const next = togglePanel(config, 'namelookup', false)
    expect(next !== null).toBeTruthy()
    savePanelConfig(next!)
    expect(isPanelEnabled(loadPanelConfig(), panel.id, 'task')).toBe(false)
  })

  test('returns null for unknown panel', () => {
    const config = loadPanelConfig()
    expect(togglePanel(config, 'nonexistent', false)).toBe(null)
  })
})
