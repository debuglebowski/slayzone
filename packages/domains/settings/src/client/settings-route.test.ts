import { describe, expect, it } from 'vitest'
import {
  routeFromLegacyTab,
  routeFromProjectTab,
  sameRoute,
  settingsPageKey,
  type SettingsRoute
} from './settings-route'

describe('routeFromLegacyTab', () => {
  const cases: Array<[string | undefined, SettingsRoute]> = [
    [undefined, { kind: 'prefs', page: 'appearance' }],
    ['appearance', { kind: 'prefs', page: 'appearance' }],
    ['appearance/layout', { kind: 'prefs', page: 'layout' }],
    ['panels', { kind: 'prefs', page: 'panels' }],
    ['panels/terminal', { kind: 'prefs', page: 'panels/terminal' }],
    ['panels/web:figma', { kind: 'prefs', page: 'panels/web:figma' }],
    ['telemetry', { kind: 'prefs', page: 'telemetry' }],
    ['labs', { kind: 'app', page: 'labs' }],
    ['about', { kind: 'app', page: 'about' }],
    ['diagnostics', { kind: 'app', page: 'about' }],
    ['cli', { kind: 'app', page: 'cli' }],
    ['worktrees', { kind: 'hub', hubId: null, tab: 'worktrees' }],
    ['ai-providers', { kind: 'hub', hubId: null, tab: 'agents' }],
    ['ai-providers/codex', { kind: 'hub', hubId: null, tab: 'agents', sub: 'codex' }],
    ['permissions', { kind: 'hub', hubId: null, tab: 'agents' }],
    ['hooks', { kind: 'hub', hubId: null, tab: 'agents' }],
    ['mcp', { kind: 'hub', hubId: null, tab: 'mcp' }],
    ['backup', { kind: 'hub', hubId: null, tab: 'backups' }],
    ['data', { kind: 'hub', hubId: null, tab: 'data' }],
    ['connections', { kind: 'hubs' }],
    ['hubs', { kind: 'hubs' }],
    ['server', { kind: 'hubs' }],
    ['computer', { kind: 'hubs' }],
    ['no-such-tab', { kind: 'prefs', page: 'appearance' }]
  ]
  it.each(cases)('%s', (tab, route) => {
    expect(routeFromLegacyTab(tab)).toEqual(route)
  })
})

describe('routeFromProjectTab', () => {
  it('maps the project dialog tabs onto project routes', () => {
    expect(routeFromProjectTab('p1')).toEqual({ kind: 'project', projectId: 'p1', tab: 'general' })
    expect(routeFromProjectTab('p1', 'tasks/statuses')).toEqual({
      kind: 'project',
      projectId: 'p1',
      tab: 'tasks/statuses'
    })
    expect(routeFromProjectTab('p1', 'integrations')).toEqual({
      kind: 'project',
      projectId: 'p1',
      tab: 'integrations'
    })
  })
})

describe('sameRoute', () => {
  it('compares structurally', () => {
    expect(sameRoute({ kind: 'hubs' }, { kind: 'hubs' })).toBe(true)
    expect(
      sameRoute({ kind: 'hub', hubId: 'a', tab: 'mcp' }, { kind: 'hub', hubId: 'a', tab: 'agents' })
    ).toBe(false)
  })
})

describe('settingsPageKey', () => {
  it('ignores the one-shot onboarding request, so acknowledging it keeps the page mounted', () => {
    // The onboarding route forces Integrations; its acknowledgement navigates here.
    expect(
      settingsPageKey({ kind: 'project', projectId: 'p', tab: 'general', onboarding: 'linear' })
    ).toBe(settingsPageKey({ kind: 'project', projectId: 'p', tab: 'integrations' }))
  })

  it('still tells real pages apart', () => {
    expect(settingsPageKey({ kind: 'project', projectId: 'p', tab: 'general' })).not.toBe(
      settingsPageKey({ kind: 'project', projectId: 'p', tab: 'integrations' })
    )
    expect(settingsPageKey({ kind: 'project', projectId: 'p', tab: 'general' })).not.toBe(
      settingsPageKey({ kind: 'project', projectId: 'q', tab: 'general' })
    )
    expect(settingsPageKey({ kind: 'prefs', page: 'appearance' })).not.toBe(
      settingsPageKey({ kind: 'prefs', page: 'layout' })
    )
  })
})
