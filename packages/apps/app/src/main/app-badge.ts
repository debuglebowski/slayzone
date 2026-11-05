/**
 * App icon badge, main side. The renderer decides WHAT to show (settings +
 * task statuses, `computeAppBadge` in @slayzone/settings) and sends it over
 * `app:set-badge`; this file only puts it on the platform's icon:
 *   - macOS: dock badge text
 *   - Linux: launcher count (numbers only)
 *   - Windows: taskbar overlay icon (an image — the renderer draws it, main has no canvas)
 */

export interface AppBadgePayload {
  /** '' = no badge. */
  text: string
  /** Distinct matching tasks. */
  count: number
  /** PNG data URL for the Windows overlay; null where the renderer didn't draw one. */
  overlayPng: string | null
}

export interface AppBadgeHost {
  platform: NodeJS.Platform
  setDockBadge: (text: string) => void
  setBadgeCount: (count: number) => void
  /** null = clear. */
  setOverlayIcon: (pngDataUrl: string | null, description: string) => void
}

const MAX_TEXT = 16
const MAX_OVERLAY_CHARS = 100_000
const PNG_PREFIX = 'data:image/png;base64,'

export function parseAppBadgePayload(raw: unknown): AppBadgePayload | null {
  if (!raw || typeof raw !== 'object') return null
  const { text, count, overlayPng } = raw as Record<string, unknown>
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null
  const overlay =
    typeof overlayPng === 'string' &&
    overlayPng.startsWith(PNG_PREFIX) &&
    overlayPng.length <= MAX_OVERLAY_CHARS
      ? overlayPng
      : null
  return { text, count, overlayPng: overlay }
}

export function applyAppBadge(host: AppBadgeHost, badge: AppBadgePayload): void {
  switch (host.platform) {
    case 'darwin':
      host.setDockBadge(badge.text)
      return
    case 'win32':
      host.setOverlayIcon(badge.text ? badge.overlayPng : null, badge.text)
      return
    default:
      host.setBadgeCount(badge.text ? badge.count : 0)
  }
}
