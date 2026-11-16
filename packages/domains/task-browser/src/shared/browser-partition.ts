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

/** A partition a browser panel / web panel may use. */
export function isBrowserPanelPartition(p: string): boolean {
  if (p === LOCAL_BROWSER_PARTITION || p === WEB_PANEL_PARTITION) return true
  return /^persist:browser-tabs-hub-[0-9a-f]{8}(-[a-z0-9-]{1,32})?$/.test(p)
}
