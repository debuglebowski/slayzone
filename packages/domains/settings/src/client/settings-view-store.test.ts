// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeSettings,
  installSettingsEventBridge,
  openSettings,
  useSettingsViewStore
} from './settings-view-store'

beforeEach(() => closeSettings())
afterEach(() => closeSettings())

describe('settings view store', () => {
  it('opens on a route, or the default page', () => {
    openSettings()
    expect(useSettingsViewStore.getState()).toMatchObject({
      open: true,
      route: { kind: 'prefs', page: 'appearance' }
    })
    openSettings({ kind: 'hub', hubId: 'h', tab: 'mcp' })
    expect(useSettingsViewStore.getState().route).toEqual({ kind: 'hub', hubId: 'h', tab: 'mcp' })
  })

  it('accepts a legacy tab key', () => {
    openSettings('worktrees')
    expect(useSettingsViewStore.getState().route).toEqual({
      kind: 'hub',
      hubId: null,
      tab: 'worktrees'
    })
  })

  it('navigates while open and closes', () => {
    openSettings()
    useSettingsViewStore.getState().navigate({ kind: 'app', page: 'labs' })
    expect(useSettingsViewStore.getState().route).toEqual({ kind: 'app', page: 'labs' })
    closeSettings()
    expect(useSettingsViewStore.getState().open).toBe(false)
  })
})

describe('close', () => {
  it('bumps the revision only when it actually closes', () => {
    const r0 = useSettingsViewStore.getState().revision
    closeSettings()
    expect(useSettingsViewStore.getState().revision).toBe(r0)
    openSettings()
    closeSettings()
    expect(useSettingsViewStore.getState().revision).toBe(r0 + 1)
  })
})

describe('event bridge', () => {
  it('leaves project settings to the shell unless asked', () => {
    const off = installSettingsEventBridge()
    window.dispatchEvent(new CustomEvent('open-project-settings', { detail: { projectId: 'p1' } }))
    expect(useSettingsViewStore.getState().open).toBe(false)
    off()
  })

  it('routes open-settings and open-project-settings events', () => {
    const off = installSettingsEventBridge({ projects: true })
    window.dispatchEvent(new CustomEvent('open-settings', { detail: 'mcp' }))
    expect(useSettingsViewStore.getState()).toMatchObject({
      open: true,
      route: { kind: 'hub', hubId: null, tab: 'mcp' }
    })
    window.dispatchEvent(
      new CustomEvent('open-settings', { detail: { kind: 'app', page: 'about' } })
    )
    expect(useSettingsViewStore.getState().route).toEqual({ kind: 'app', page: 'about' })
    window.dispatchEvent(
      new CustomEvent('open-project-settings', { detail: { projectId: 'p1', tab: 'tests' } })
    )
    expect(useSettingsViewStore.getState().route).toEqual({
      kind: 'project',
      projectId: 'p1',
      tab: 'tests'
    })
    off()
    closeSettings()
    window.dispatchEvent(new CustomEvent('open-settings', { detail: 'mcp' }))
    expect(useSettingsViewStore.getState().open).toBe(false)
  })
})
