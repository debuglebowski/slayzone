/**
 * App icon badge (macOS dock / Windows taskbar overlay / Linux launcher count):
 * which task statuses it counts and how it shows them. Pure — the settings
 * snapshot in, the badge out — so the renderer hook and the settings card share
 * one definition.
 *
 * Stored as hub settings next to Appearance (shared, not per machine).
 */

export type AppBadgeSource = 'unread' | 'idle'
/** count = distinct tasks matching any source; separate = one number per source; dot = no number. */
export type AppBadgeStyle = 'count' | 'separate' | 'dot'
export type AppBadgeScope = 'all' | 'selected'

export interface AppBadgeSettings {
  /** Fixed order (unread, idle). Empty = badge off. */
  sources: AppBadgeSource[]
  style: AppBadgeStyle
  scope: AppBadgeScope
  /** `appBadgeProjectKey(hubId, projectId)` — project ids are only unique within one hub. */
  projects: string[]
  /** Count only tasks that are open as tabs. */
  openTabsOnly: boolean
}

export interface AppBadgeTask {
  taskId: string
  /** `appBadgeProjectKey(hubId, projectId)` */
  projectKey: string
}

export interface AppBadge {
  /** '' = no badge. */
  text: string
  /** Distinct matching tasks (the numeric badge on platforms that only take numbers). */
  count: number
}

export const APP_BADGE_KEYS = {
  sources: 'app_badge_sources',
  style: 'app_badge_style',
  scope: 'app_badge_scope',
  projects: 'app_badge_projects',
  openTabsOnly: 'app_badge_open_tabs_only'
} as const

export const APP_BADGE_SOURCES: readonly AppBadgeSource[] = ['unread', 'idle']
const STYLES: readonly AppBadgeStyle[] = ['count', 'separate', 'dot']
const MAX_SHOWN = 99

export function appBadgeProjectKey(hubId: string, projectId: string): string {
  return `${hubId}:${projectId}`
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function parseAppBadgeSettings(all: Record<string, string>): AppBadgeSettings {
  const saved = new Set(parseStringArray(all[APP_BADGE_KEYS.sources]))
  const style = all[APP_BADGE_KEYS.style] as AppBadgeStyle
  return {
    sources: APP_BADGE_SOURCES.filter((s) => saved.has(s)),
    style: STYLES.includes(style) ? style : 'count',
    scope: all[APP_BADGE_KEYS.scope] === 'selected' ? 'selected' : 'all',
    projects: parseStringArray(all[APP_BADGE_KEYS.projects]),
    openTabsOnly: all[APP_BADGE_KEYS.openTabsOnly] === 'true'
  }
}

function formatCount(n: number): string {
  return n > MAX_SHOWN ? `${MAX_SHOWN}+` : String(n)
}

export function computeAppBadge(
  settings: AppBadgeSettings,
  tasks: Record<AppBadgeSource, readonly AppBadgeTask[]>,
  /** Task ids open as tabs; only consulted when `openTabsOnly` is on. */
  openTaskIds: ReadonlySet<string> = new Set()
): AppBadge {
  const chosen = settings.scope === 'selected' ? new Set(settings.projects) : null
  const open = settings.openTabsOnly ? openTaskIds : null
  const enabled = APP_BADGE_SOURCES.filter((s) => settings.sources.includes(s))
  const perSource = enabled.map((source) => {
    const ids = new Set<string>()
    for (const task of tasks[source]) {
      if (chosen && !chosen.has(task.projectKey)) continue
      if (open && !open.has(task.taskId)) continue
      ids.add(task.taskId)
    }
    return ids
  })
  const all = new Set<string>()
  for (const ids of perSource) for (const id of ids) all.add(id)
  const count = all.size
  if (count === 0) return { text: '', count: 0 }

  switch (settings.style) {
    case 'dot':
      return { text: '•', count }
    case 'separate':
      return { text: perSource.map((ids) => formatCount(ids.size)).join('·'), count }
    default:
      return { text: formatCount(count), count }
  }
}
