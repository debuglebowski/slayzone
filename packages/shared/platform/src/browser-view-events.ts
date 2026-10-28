/**
 * Events a WebContentsView (task browser tab or web panel) forwards from the
 * Electron main process back to the renderer, via the transport `app` router.
 *
 * Lives here, not in `@slayzone/task-browser`, because transport and
 * `@slayzone/types` need it and task-browser depends on transport.
 *
 * Type-only and dependency-free: also the lean
 * `@slayzone/platform/browser-view-events` subpath, safe to import from
 * renderer bundles.
 */
export type BrowserCreateTaskFromLinkSource = 'modified-link-click' | 'link-context-menu'

export interface BrowserCreateTaskFromLinkIntent {
  viewId: string
  taskId: string
  url: string
  linkText?: string
  source: BrowserCreateTaskFromLinkSource
}

/** A keyboard shortcut forwarded from a WebContentsView back into the renderer
 *  DOM (the view is a separate web contents, so renderer key handlers never see
 *  it). `kind` distinguishes browser tabs from web panels (scope routing). */
export interface BrowserShortcutPayload {
  viewId: string
  key: string
  shift: boolean
  alt: boolean
  meta: boolean
  control: boolean
  kind?: string
}
