import type { BrowserTabsState } from '@slayzone/task-browser/shared'

/**
 * The first tab URL in `state` worth reopening — anything but empty or
 * `about:blank`. A task with no browser state of its own opens on its project
 * siblings' first such URL; the client scan and the hub's
 * `task.getSiblingBrowserUrl` both use this so the two cannot disagree.
 */
export function firstRealBrowserUrl(
  state: Pick<BrowserTabsState, 'tabs'> | null | undefined
): string | null {
  const tabs = state?.tabs
  if (!Array.isArray(tabs)) return null
  for (const tab of tabs) {
    const url = (tab as { url?: unknown } | null)?.url
    if (typeof url === 'string' && url && url !== 'about:blank') return url
  }
  return null
}
