/**
 * CLI panels command tests
 * Run with: ELECTRON_RUN_AS_NODE=1 electron --import tsx/esm packages/apps/cli/test/panels.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter, captureAllAsync } from './test-harness.js'
import type { PanelConfig, WebPanelDefinition } from '../../../domains/task/src/shared/types.js'
import { DEFAULT_PANEL_CONFIG, PREDEFINED_WEB_PANELS } from '../../../domains/task/src/shared/types.js'
import { mergePredefinedWebPanels, validatePanelShortcut } from '../../../domains/task/src/shared/panel-config.js'
import { normalizeDesktopProtocol, inferProtocolFromUrl, inferHostScopeFromUrl } from '../../../domains/task/src/shared/handoff.js'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

// --- helpers ---

function loadPanelConfig(): PanelConfig {
  const row = db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'panel_config' LIMIT 1`)
  if (!row[0]?.value) return { ...DEFAULT_PANEL_CONFIG }
  return mergePredefinedWebPanels(JSON.parse(row[0].value) as PanelConfig)
}

function savePanelConfig(config: PanelConfig) {
  db.run(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)`,
    { ':key': 'panel_config', ':value': JSON.stringify(config) }
  )
}

function createPanel(name: string, rawUrl: string, opts: { shortcut?: string; blockHandoff?: boolean; protocol?: string } = {}): WebPanelDefinition {
  const config = loadPanelConfig()

  let url = rawUrl.trim()
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`

  const newPanel: WebPanelDefinition = {
    id: `web:${crypto.randomUUID().slice(0, 8)}`,
    name: name.trim(),
    baseUrl: url,
    shortcut: opts.shortcut?.trim().toLowerCase() || undefined,
    blockDesktopHandoff: opts.blockHandoff || undefined,
    handoffProtocol: opts.blockHandoff ? (normalizeDesktopProtocol(opts.protocol ?? null) ?? inferProtocolFromUrl(url) ?? undefined) : undefined,
    handoffHostScope: opts.blockHandoff ? (inferHostScopeFromUrl(url) ?? undefined) : undefined,
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
    for (const key of ['t', 'b', 'e', 'g', 's']) {
      const err = validatePanelShortcut(key, [])
      expect(err !== null && err.includes('reserved for a built-in panel')).toBeTruthy()
    }
  })

  test('rejects duplicate shortcut', () => {
    const panels: WebPanelDefinition[] = [{ id: 'web:test', name: 'Test', baseUrl: 'https://test.com', shortcut: 'a' }]
    const err = validatePanelShortcut('a', panels)
    expect(err !== null && err.includes('already used by Test')).toBeTruthy()
  })

  test('allows duplicate when excludeId matches', () => {
    const panels: WebPanelDefinition[] = [{ id: 'web:test', name: 'Test', baseUrl: 'https://test.com', shortcut: 'a' }]
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
    const found = config.webPanels.find(p => p.id === panel.id)
    expect(found !== undefined).toBeTruthy()
    expect(found!.name).toBe('Linear')
    expect(found!.baseUrl).toBe('https://linear.app')
  })

  test('normalizes URL without protocol', () => {
    const panel = createPanel('Example', 'example.com')
    const config = loadPanelConfig()
    const found = config.webPanels.find(p => p.id === panel.id)
    expect(found!.baseUrl).toBe('https://example.com')
  })

  test('preserves http:// URL', () => {
    const panel = createPanel('Local', 'http://localhost:3000')
    const config = loadPanelConfig()
    const found = config.webPanels.find(p => p.id === panel.id)
    expect(found!.baseUrl).toBe('http://localhost:3000')
  })

  test('stores shortcut as lowercase', () => {
    const panel = createPanel('Shortcut Test', 'https://test.com', { shortcut: 'Z' })
    const config = loadPanelConfig()
    const found = config.webPanels.find(p => p.id === panel.id)
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
    const found = config.webPanels.find(p => p.id === panel.id)
    expect(found!.blockDesktopHandoff).toBe(true)
    expect(found!.handoffProtocol).toBe('figma-clone')
    expect(found!.handoffHostScope).toBe('figma-clone.com')
  })

  test('creates with explicit protocol', () => {
    const panel = createPanel('Custom Proto', 'https://app.custom.io', { blockHandoff: true, protocol: 'myproto' })
    const config = loadPanelConfig()
    const found = config.webPanels.find(p => p.id === panel.id)
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
    const ids = config.webPanels.map(p => p.id)
    expect(ids).toContain('web:figma')
    expect(ids).toContain('web:notion')
  })
})

h.cleanup()
console.log('\nDone')
