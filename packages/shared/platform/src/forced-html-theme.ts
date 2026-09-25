/**
 * Forcing a color scheme onto HTML the app doesn't control (task artifacts,
 * browser tabs).
 *
 * This replaces an earlier implementation that forced "dark" with
 * `html{filter:invert(90%) hue-rotate(180deg)}`. Inversion is not a theme: it
 * flips whatever the page already is, so forcing dark onto a page authored
 * dark produced a *light* page, and every attempt to darken such a page made
 * it lighter on screen.
 *
 * Forcing a theme means making the page render its own authored palette for
 * the scheme we ask for. That is three layers, applied together:
 *
 *   1. `buildEmulatedMediaParams` — CDP `Emulation.setEmulatedMedia`. Changes
 *      what the engine itself reports for `prefers-color-scheme`, so every
 *      stylesheet agrees, including CSS injected at runtime (Tailwind's CDN
 *      build, CSS-in-JS, `insertRule`, `adoptedStyleSheets`) that no
 *      source-level rewrite could ever reach. The only complete layer, and
 *      the only per-webContents lever Electron exposes — `nativeTheme
 *      .themeSource` is app-global and would flip our own chrome and the OS
 *      menus with it.
 *   2. `buildForcedHtmlThemeCss` — `color-scheme`, for the surfaces CSS alone
 *      owns: scrollbars, form controls, `light-dark()`.
 *   3. `buildForcedHtmlThemeScript` / `injectForcedHtmlTheme` — the
 *      `data-theme` attribute, which pages offering their own theme toggle
 *      key off in addition to the media query.
 *
 * Layers 2 and 3 also stand alone: they need no debugger session, so a view
 * whose CDP session is displaced (DevTools) degrades instead of reverting.
 *
 * Note the deliberate limit. A page with no dark styling at all stays light
 * when dark is forced — we force the *preference*, the page decides what to
 * do with it. Inversion appeared to handle that case by brute force, at the
 * cost of being wrong for every page that did style itself.
 */

export type ForcedHtmlTheme = 'light' | 'dark'
export type HtmlThemeMode = 'system' | ForcedHtmlTheme

/** Toggle order shared by the artifacts preview header and the browser toolbar. */
export const HTML_THEME_CYCLE: readonly HtmlThemeMode[] = ['system', 'dark', 'light']

export function nextHtmlTheme(current: HtmlThemeMode): HtmlThemeMode {
  const i = HTML_THEME_CYCLE.indexOf(current)
  return HTML_THEME_CYCLE[(i + 1) % HTML_THEME_CYCLE.length]
}

/** `id` of the injected stylesheet, so re-applying replaces rather than stacks. */
export const FORCED_HTML_THEME_STYLE_ID = 'slz-forced-theme'

/** The attribute pages key their own theme choice off. */
export const FORCED_HTML_THEME_ATTR = 'data-theme'

/**
 * Where the page's own `data-theme` is parked while an override is in force,
 * so clearing the override restores it rather than deleting it. Absent-before
 * is recorded as the empty string, which `data-theme` itself never carries.
 */
const PREV_ATTR = 'data-slz-prev-theme'

/**
 * CDP params for `Emulation.setEmulatedMedia`. `null` builds the reset call —
 * the command has no separate disable, an empty feature list is how you clear.
 */
export function buildEmulatedMediaParams(theme: ForcedHtmlTheme | null): {
  features: Array<{ name: string; value: string }>
} {
  return theme ? { features: [{ name: 'prefers-color-scheme', value: theme }] } : { features: [] }
}

/**
 * `color-scheme` only. `!important` because the point is to beat a page that
 * hardcodes the opposite scheme — but it is one property with one meaning,
 * not a filter over the whole document.
 */
export function buildForcedHtmlThemeCss(theme: ForcedHtmlTheme): string {
  return `:root{color-scheme:${theme} !important}`
}

/**
 * JS that applies (or, for `null`, clears) layers 2 and 3 in a live document.
 * Used for pages whose bytes we don't serve — run on `dom-ready` and after
 * each navigation, so it must be idempotent and must not compound.
 */
export function buildForcedHtmlThemeScript(theme: ForcedHtmlTheme | null): string {
  const t = JSON.stringify(theme)
  const attr = JSON.stringify(FORCED_HTML_THEME_ATTR)
  const prev = JSON.stringify(PREV_ATTR)
  const id = JSON.stringify(FORCED_HTML_THEME_STYLE_ID)
  const css = JSON.stringify(theme ? buildForcedHtmlThemeCss(theme) : '')
  return `(function(){try{
var d=document,r=d&&d.documentElement;if(!r)return;
var old=d.getElementById(${id});if(old&&old.parentNode)old.parentNode.removeChild(old);
var t=${t};
if(!t){var p=r.getAttribute(${prev});if(p!==null){if(p==="")r.removeAttribute(${attr});else r.setAttribute(${attr},p);r.removeAttribute(${prev})}return}
if(r.getAttribute(${prev})===null)r.setAttribute(${prev},r.getAttribute(${attr})||"");
r.setAttribute(${attr},t);
var s=d.createElement("style");s.id=${id};s.textContent=${css};(d.head||r).appendChild(s);
}catch(e){}})()`
}

/**
 * Serve-time version of the same two layers, for bytes we do serve. Applying
 * these at parse time rather than on `dom-ready` means the document is never
 * painted in the wrong scheme first.
 */
export function injectForcedHtmlTheme(html: string, theme: ForcedHtmlTheme): string {
  const style = `<style id="${FORCED_HTML_THEME_STYLE_ID}">${buildForcedHtmlThemeCss(theme)}</style>`

  // Stamp the attribute on the real <html> tag where there is one. A document
  // without one still parses to a documentElement, but only a script can reach
  // it, so that case falls back to one.
  let out = html
  let stamped = false
  const openTag = /<html\b([^>]*)>/i.exec(out)
  if (openTag) {
    const attrs = openTag[1].replace(
      new RegExp(`\\s${FORCED_HTML_THEME_ATTR}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i'),
      ''
    )
    const replacement = `<html${attrs} ${FORCED_HTML_THEME_ATTR}="${theme}">`
    out = out.slice(0, openTag.index) + replacement + out.slice(openTag.index + openTag[0].length)
    stamped = true
  }

  const block = stamped ? style : `${style}<script>${buildForcedHtmlThemeScript(theme)}</script>`

  const headClose = out.search(/<\/head\s*>/i)
  return headClose >= 0 ? out.slice(0, headClose) + block + out.slice(headClose) : block + out
}
