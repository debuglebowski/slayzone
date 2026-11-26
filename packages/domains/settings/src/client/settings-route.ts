/**
 * Where the full-window Settings view is (plans/settings-by-scope.md).
 *
 * A route names the scope a page edits, not a tab key: `prefs` and `app` pages are
 * this client's own; `hub`, `computer` and `project` pages render inside the owning
 * hub's `HubScope`, so every read and write goes to that hub. `hubId: null` is the
 * default hub, resolved when the page renders (legacy deep links never knew a hub).
 *
 * Structured rather than a path string: hub ids are `hub:<ws url>`, which a
 * `/`-joined path could not carry unambiguously.
 */
export type SettingsRoute =
  | { kind: 'prefs'; page: string }
  | { kind: 'app'; page: string }
  | { kind: 'hubs' }
  /** Every project on every hub, compared (phase 5). */
  | { kind: 'projects' }
  /** Search across every page, hub, computer and project. */
  | { kind: 'search'; query: string }
  | { kind: 'hub'; hubId: string | null; tab: string; sub?: string }
  | { kind: 'computer'; hubId: string; computerId: string; tab: string }
  | {
      kind: 'project'
      projectId: string
      tab: string
      /** A project just created from GitHub/Linear: Integrations opens its onboarding. */
      onboarding?: 'github' | 'linear' | 'jira'
    }

export const DEFAULT_SETTINGS_ROUTE: SettingsRoute = { kind: 'prefs', page: 'appearance' }

const PREFS_PAGES = new Set(['appearance', 'layout', 'lenses', 'panels', 'telemetry'])
const APP_PAGES = new Set(['labs', 'about', 'cli'])
/** Old dialog tab keys whose content is hub-wide. */
const HUB_TABS: Record<string, string> = {
  worktrees: 'worktrees',
  'ai-providers': 'agents',
  // chat slash builtins (`/permissions`, `/hooks`) always pointed here; the dialog
  // never had those keys and opened blank
  permissions: 'agents',
  hooks: 'agents',
  mcp: 'mcp',
  backup: 'backups',
  data: 'data'
}
const HUBS_TABS = new Set(['connections', 'hubs', 'server', 'computer'])

/**
 * A tab key of the retired Settings dialog (the `open-settings` event detail, chat
 * builtins, `WorktreesTab`'s link) → its route. Unknown keys open the default page
 * rather than a blank one.
 */
export function routeFromLegacyTab(tab: string | null | undefined): SettingsRoute {
  if (!tab) return DEFAULT_SETTINGS_ROUTE
  if (tab === 'appearance/layout') return { kind: 'prefs', page: 'layout' }
  if (tab === 'panels' || tab.startsWith('panels/')) return { kind: 'prefs', page: tab }
  if (PREFS_PAGES.has(tab)) return { kind: 'prefs', page: tab }
  if (APP_PAGES.has(tab)) return { kind: 'app', page: tab }
  // Diagnostics moved into About.
  if (tab === 'diagnostics') return { kind: 'app', page: 'about' }
  if (HUBS_TABS.has(tab)) return { kind: 'hubs' }
  if (tab.startsWith('ai-providers/')) {
    return { kind: 'hub', hubId: null, tab: 'agents', sub: tab.slice('ai-providers/'.length) }
  }
  const hubTab = HUB_TABS[tab]
  if (hubTab) return { kind: 'hub', hubId: null, tab: hubTab }
  return DEFAULT_SETTINGS_ROUTE
}

/** The retired project-settings dialog's `initialTab` → the project's route. */
export function routeFromProjectTab(projectId: string, tab?: string | null): SettingsRoute {
  return { kind: 'project', projectId, tab: tab || 'general' }
}

export function sameRoute(a: SettingsRoute, b: SettingsRoute): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
