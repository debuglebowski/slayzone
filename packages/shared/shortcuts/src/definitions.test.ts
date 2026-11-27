import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Platform } from './platform'

/** Load definitions as they resolve on `platform` (defaults are picked at module load). */
async function defaultsOn(platform: Platform): Promise<Record<string, string | null>> {
  vi.resetModules()
  vi.doMock('./platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./platform')>()),
    detectPlatform: () => platform
  }))
  const { shortcutDefinitions } = await import('./definitions')
  return Object.fromEntries(shortcutDefinitions.map((d) => [d.id, d.defaultKeys]))
}

afterEach(() => {
  vi.doUnmock('./platform')
  vi.resetModules()
})

describe('lens switching never collides with tab switching', () => {
  it('macOS: ⌃1–9 (⌘1–9 switches tabs)', async () => {
    const d = await defaultsOn('mac')
    expect(d['switch-lens-1-9']).toBe('ctrl+1-9')
  })

  it('Windows/Linux: Alt+1–9 (mod is Ctrl there)', async () => {
    const d = await defaultsOn('other')
    expect(d['switch-lens-1-9']).toBe('alt+1-9')
    expect(d['switch-tab-1-9']).toBe('mod+1-9')
  })
})

describe('layout switching (⌃⌥1–9) collides with nothing', () => {
  for (const platform of ['mac', 'other'] as const) {
    it(`${platform}: ctrl+alt+N for layouts 1–9, no other default uses it`, async () => {
      const d = await defaultsOn(platform)
      for (let n = 1; n <= 9; n++) expect(d[`switch-layout-${n}`]).toBe(`ctrl+alt+${n}`)
      const layoutKeys = new Set(Array.from({ length: 9 }, (_, i) => `ctrl+alt+${i + 1}`))
      const others = Object.entries(d).filter(([id]) => !id.startsWith('switch-layout-'))
      expect(others.filter(([, keys]) => keys && layoutKeys.has(keys))).toEqual([])
      expect(d['switch-lens-1-9']?.startsWith('ctrl+alt')).toBe(false)
    })
  }
})

describe('task-tab shortcut defaults follow the platform convention', () => {
  it('macOS: ⌘⌥← / ⌘⌥→', async () => {
    const d = await defaultsOn('mac')
    expect(d['next-task-tab']).toBe('mod+alt+arrowright')
    expect(d['prev-task-tab']).toBe('mod+alt+arrowleft')
  })

  it('Windows/Linux: Ctrl+PgDn / Ctrl+PgUp', async () => {
    const d = await defaultsOn('other')
    expect(d['next-task-tab']).toBe('mod+pagedown')
    expect(d['prev-task-tab']).toBe('mod+pageup')
  })
})
