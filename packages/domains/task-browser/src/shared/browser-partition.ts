/**
 * Which cookie jar (Electron session partition) a task's browser uses.
 *
 * The local hub keeps the long-standing `persist:browser-tabs`, so users keep the
 * logins they already have. Every remote hub gets its OWN persistent partition: a
 * remote hub — or an agent on one of its tasks — drives the panel through
 * `slay browser`, and must never act inside the sessions the user signed into for
 * local work. Extensions are installed on the local partition only.
 *
 * Pure: the renderer picks the partition, Electron main refuses any other shape.
 */
export const LOCAL_BROWSER_PARTITION = 'persist:browser-tabs'
export const WEB_PANEL_PARTITION = 'persist:web-panels'
/**
 * The local hub's ISOLATED browser: the tabs an untrusted caller (an agent on another
 * computer) opens and uses. In memory only (no `persist:`) — empty at every start,
 * nothing of the user's — and under the untrusted session policy like a remote hub's.
 */
export const ISOLATED_BROWSER_PARTITION = 'browser-tabs-isolated'
const REMOTE_PREFIX = 'persist:browser-tabs-hub-'

/** FNV-1a 32-bit, hex: stable across runs, distinct for hub ids that only differ in punctuation. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function browserPartitionForHub(hubId: string, hubIsLocal: boolean): string {
  if (hubIsLocal) return LOCAL_BROWSER_PARTITION
  const readable = hubId
    .toLowerCase()
    .replace(/^hub:/, '')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return `${REMOTE_PREFIX}${fnv1a(hubId)}${readable ? `-${readable}` : ''}`
}

/**
 * One tab's partition: an isolated tab of the local hub browses in the isolated
 * partition; every other tab in its hub's (`browserPartitionForHub`). A remote hub's
 * partition is already isolated from the user's own browser.
 */
export function browserPartitionForTab(hubPartition: string, tab: { isolated?: boolean }): string {
  return tab.isolated && hubPartition === LOCAL_BROWSER_PARTITION
    ? ISOLATED_BROWSER_PARTITION
    : hubPartition
}

/** The user's own browser (their logins, local files): only trusted callers reach it. */
export function isUsersOwnPartition(p: string): boolean {
  return p === LOCAL_BROWSER_PARTITION
}

/** A partition a browser panel / web panel may use. */
export function isBrowserPanelPartition(p: string): boolean {
  if (p === LOCAL_BROWSER_PARTITION || p === WEB_PANEL_PARTITION) return true
  if (p === ISOLATED_BROWSER_PARTITION) return true
  return /^persist:browser-tabs-hub-[0-9a-f]{8}(-[a-z0-9-]{1,32})?$/.test(p)
}
