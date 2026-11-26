/**
 * Panel kinds whose instances carry their content in their settings
 * (docs/plans/panel-model.md step 12):
 *
 * - **Web page** — a `web` instance with `settings.url`: one static URL, no
 *   browser chrome. An empty `url` is a page not set up yet (it asks for one).
 *   A configured web panel (`panel_config.webPanels`) is a `web` instance with
 *   `settings.panelId` instead, and never has `url`.
 * - **Artifact** — one task artifact (`settings.artifactId`).
 * - **Description / Subtasks / Details** — the Settings panel's cards on their
 *   own: one each per task, like Settings.
 */
import { instancesOfKind } from './instances'
import type { LayoutTree, PanelInstance, PanelInstanceSettings, PanelKind } from './types'

/** Kinds a task holds at most one instance of: adding another shows the one it has. */
export const ONE_PER_TASK_KINDS: readonly PanelKind[] = [
  'settings',
  'description',
  'subtasks',
  'details'
]

// ── Web page ─────────────────────────────────────────────────────────────────

/** A "Web page" panel (static URL), not a configured web panel. */
export function isWebPageInstance(inst: PanelInstance | undefined): boolean {
  return inst?.kind === 'web' && typeof inst.settings.url === 'string'
}

/** The page's URL; null while it is not set up yet (or not a web page). */
export function webPageUrlOf(inst: PanelInstance | undefined): string | null {
  if (!inst || !isWebPageInstance(inst)) return null
  const url = inst.settings.url as string
  return url === '' ? null : url
}

/** Settings of a new web page: `url` set (empty = ask for it when it first shows). */
export function webPageSettings(url = ''): PanelInstanceSettings {
  return { url }
}

const SCHEMES = new Set(['http:', 'https:', 'file:'])

/**
 * What the user typed → the URL a web page loads, or null when it is no usable
 * URL. A bare host (`example.com/x`, `localhost:3000`) gets `https://`, or
 * `http://` for loopback; it needs a dot, a port or `localhost` to count as one.
 * Only http(s) and file URLs.
 */
export function normalizeWebPageUrl(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || /\s/.test(text)) return null
  // `host:port…` is a bare host, not a scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text)
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text)
  const candidate = hasScheme ? text : `${loopback ? 'http' : 'https'}://${text}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (!SCHEMES.has(url.protocol)) return null
  if (url.protocol !== 'file:') {
    if (url.hostname === '') return null
    if (!hasScheme && !loopback && !url.hostname.includes('.') && url.port === '') return null
  }
  return url.href
}

/** A web page's short name: its host (`grafana.example.com`), or the URL itself. */
export function webPageLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.host || u.pathname.split('/').filter(Boolean).at(-1) || url
  } catch {
    return url
  }
}

// ── Artifact ─────────────────────────────────────────────────────────────────

/** The artifact an Artifact panel shows, or null. */
export function artifactIdOf(inst: PanelInstance | undefined): string | null {
  if (inst?.kind !== 'artifact') return null
  const id = inst.settings.artifactId
  return typeof id === 'string' && id !== '' ? id : null
}

// ── Adding ───────────────────────────────────────────────────────────────────

/**
 * The instance to show instead of adding a new one of `kind` with `settings`: the
 * task's instance of a one-per-task kind, or the Artifact panel already showing
 * that artifact. Null: add a new instance.
 */
export function existingInstanceFor(
  tree: LayoutTree,
  kind: PanelKind,
  settings: PanelInstanceSettings = {}
): string | null {
  if (ONE_PER_TASK_KINDS.includes(kind)) return instancesOfKind(tree, kind)[0]?.id ?? null
  if (kind === 'artifact') {
    const want = settings.artifactId
    if (typeof want !== 'string' || want === '') return null
    return instancesOfKind(tree, 'artifact').find((i) => artifactIdOf(i) === want)?.id ?? null
  }
  return null
}
