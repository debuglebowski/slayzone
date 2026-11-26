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
