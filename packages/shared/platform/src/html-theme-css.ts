/**
 * CSS that forces a color scheme onto HTML the app doesn't control (task
 * artifacts, browser tabs) — content that may not honor `prefers-color-scheme`
 * or was authored for only one scheme.
 *
 * `dark` inverts the whole page, then re-inverts media elements so images,
 * video, canvas, svg and nested iframes don't come out with wrong colors.
 * `light` only asserts `color-scheme: light` — it can't undo colors an
 * already-dark-authored page set explicitly; there's no way to do that
 * without understanding the page's own styles.
 *
 * Single source of truth shared by task-browser's per-tab theme override
 * (applied live via `webContents.insertCSS`) and task-artifacts' HTML
 * preview (injected as text at serve time — that iframe has no webContents
 * handle to call `insertCSS` on).
 */
export type ForcedHtmlTheme = 'light' | 'dark'

export const FORCED_HTML_THEME_CSS: Record<ForcedHtmlTheme, string> = {
  dark: [
    'html{filter:invert(90%) hue-rotate(180deg)!important}',
    'img,video,canvas,svg,iframe{filter:invert(90%) hue-rotate(180deg)!important}'
  ].join(''),
  light: ':root{color-scheme:light!important}'
}
