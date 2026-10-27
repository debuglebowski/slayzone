/**
 * Panel config merge contract tests
 */
import { expect, test } from 'vitest'
import type { PanelConfig } from './types.js'
import { mergePanelOrder, mergePredefinedWebPanels } from './panel-config.js'

test('migrates legacy blocked panels to inferred handoff protocol and host scope', () => {
  const config: PanelConfig = {
    viewEnabled: { task: { 'web:legacy': true } },
    webPanels: [
      {
        id: 'web:legacy',
        name: 'Legacy Figma',
        baseUrl: 'https://www.figma.com/file/123',
        blockDesktopHandoff: true
      }
    ]
  }

  const merged = mergePredefinedWebPanels(config)
  const legacyPanel = merged.webPanels.find((panel) => panel.id === 'web:legacy')
  expect(legacyPanel).toBeDefined()
  expect(legacyPanel?.handoffProtocol).toBe('figma')
  expect(legacyPanel?.handoffHostScope).toBe('figma.com')
})

test('does not re-add deleted predefined panels', () => {
  const config: PanelConfig = {
    viewEnabled: {},
    webPanels: [],
    deletedPredefined: ['web:figma']
  }

  const merged = mergePredefinedWebPanels(config)
  const figmaPanel = merged.webPanels.find((panel) => panel.id === 'web:figma')
  expect(figmaPanel).toBe(undefined)
})

test('mergePanelOrder renames legacy "assets" id to "artifacts" preserving position', () => {
  const config: PanelConfig = {
    viewEnabled: { task: { assets: false }, home: {} },
    webPanels: [],
    order: ['terminal', 'browser', 'editor', 'assets', 'git', 'settings', 'processes']
  }
  const merged = mergePanelOrder(config)
  expect(merged.order?.indexOf('artifacts')).toBe(3)
  expect(merged.order?.includes('assets')).toBe(false)
  expect(merged.viewEnabled.task?.artifacts).toBe(false)
  expect(merged.viewEnabled.task?.assets).toBe(undefined)
})

test('mergePanelOrder dedupes when both legacy "assets" and "artifacts" are present', () => {
  const config: PanelConfig = {
    viewEnabled: { task: { assets: false, artifacts: true }, home: {} },
    webPanels: [],
    order: ['terminal', 'assets', 'artifacts', 'git']
  }
  const merged = mergePanelOrder(config)
  // legacy 'assets' renames to 'artifacts' at idx 1, dup 'artifacts' at idx 2 dropped.
  expect(merged.order?.[1]).toBe('artifacts')
  expect(merged.order?.filter((id) => id === 'artifacts').length).toBe(1)
  // existing 'artifacts' viewEnabled wins over legacy 'assets'.
  expect(merged.viewEnabled.task?.artifacts).toBe(true)
})
