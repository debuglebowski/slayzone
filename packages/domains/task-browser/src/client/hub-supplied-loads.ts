/**
 * URLs a hub sent for a tab that does not exist yet, to load as an UNTRUSTED host
 * load once the tab registers (`planHubSuppliedUrl`). The tab is created at
 * about:blank; `BrowserTabPlaceholder` takes its URL here after `tabs.register`.
 */
const pending = new Map<string, string>()
const keyOf = (taskId: string, tabId: string): string => `${taskId}\u0000${tabId}`

export function queueUntrustedLoad(taskId: string, tabId: string, url: string): void {
  pending.set(keyOf(taskId, tabId), url)
}

/** The URL queued for this tab, once; null when none. */
export function takeUntrustedLoad(taskId: string, tabId: string): string | null {
  const key = keyOf(taskId, tabId)
  const url = pending.get(key) ?? null
  pending.delete(key)
  return url
}
