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
const REMOTE_WEB_PANEL_PREFIX = 'persist:web-panels-hub-'
const ISOLATED_REMOTE_PREFIX = 'browser-tabs-isolated-hub-'
const ISOLATED_REMOTE_RE = /^browser-tabs-isolated-hub-[0-9a-f]{8}(-[a-z0-9-]{1,32})?$/

/** FNV-1a 32-bit, hex: stable across runs, distinct for hub ids that only differ in punctuation. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** `<fnv>[-<readable>]`: one remote hub, stable, distinct per hub id. */
function hubSuffix(hubId: string): string {
  const readable = hubId
    .toLowerCase()
    .replace(/^hub:/, '')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return `${fnv1a(hubId)}${readable ? `-${readable}` : ''}`
}

export function browserPartitionForHub(hubId: string, hubIsLocal: boolean): string {
  if (hubIsLocal) return LOCAL_BROWSER_PARTITION
  return `${REMOTE_PREFIX}${hubSuffix(hubId)}`
}

/**
 * A task's WEB PANELS' partition. The local hub keeps the shared `persist:web-panels`
 * (the user's logins there). A remote hub — whose operator or agents pick its panels'
 * URLs — gets its OWN persistent partition, which Electron main runs under the
 * untrusted session policy (no permission without a prompt, public addresses only, no
 * app protocols), like a remote hub's browser tabs.
 */
export function webPanelPartitionForHub(hubId: string, hubIsLocal: boolean): string {
  if (hubIsLocal) return WEB_PANEL_PARTITION
  return `${REMOTE_WEB_PANEL_PREFIX}${hubSuffix(hubId)}`
}

/**
 * One tab's partition: an ISOLATED tab (opened for an untrusted caller) browses in an
 * in-memory isolated partition — the local hub's one, or its remote hub's own — and
 * every other tab in its hub's (`browserPartitionForHub`).
 */
export function browserPartitionForTab(hubPartition: string, tab: { isolated?: boolean }): string {
  if (!tab.isolated) return hubPartition
  if (hubPartition === LOCAL_BROWSER_PARTITION) return ISOLATED_BROWSER_PARTITION
  // A remote hub's agent tab: in memory, apart from the user's own tabs on that hub
  // (and their logins) and from every other hub's agents.
  if (hubPartition.startsWith(REMOTE_PREFIX)) {
    return `${ISOLATED_REMOTE_PREFIX}${hubPartition.slice(REMOTE_PREFIX.length)}`
  }
  return hubPartition
}

/** An isolated partition: the only kind an untrusted caller may drive a tab in. */
export function isIsolatedPartition(p: string): boolean {
  return p === ISOLATED_BROWSER_PARTITION || ISOLATED_REMOTE_RE.test(p)
}

/** The partition of the user's OWN tabs on a remote hub (not an agent's isolated one). */
export function isRemoteUserBrowserPartition(p: string): boolean {
  return /^persist:browser-tabs-hub-[0-9a-f]{8}(-[a-z0-9-]{1,32})?$/.test(p)
}

/** The user's own browser (their logins, local files): only trusted callers reach it. */
export function isUsersOwnPartition(p: string): boolean {
  return p === LOCAL_BROWSER_PARTITION
}

/** A partition a browser panel / web panel may use. */
export function isBrowserPanelPartition(p: string): boolean {
  if (p === LOCAL_BROWSER_PARTITION || p === WEB_PANEL_PARTITION) return true
  if (isIsolatedPartition(p)) return true
  return /^persist:(browser-tabs|web-panels)-hub-[0-9a-f]{8}(-[a-z0-9-]{1,32})?$/.test(p)
}
