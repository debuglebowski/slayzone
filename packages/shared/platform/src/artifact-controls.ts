/**
 * `<slay-artifact-controls>`: prototype controls an HTML artifact declares in its
 * own markup.
 *
 *   <slay-artifact-controls position="top|bottom|left|right">   (default bottom)
 *     <button data-action="next">Next</button>                   → { action: 'next' }
 *     <button data-action="tab" data-value="2">2</button>        → { action: 'tab', value: '2' }
 *     <input type="range" name="qty">                            → { action: 'qty', value: 4 }
 *   </slay-artifact-controls>
 *
 * The preview loads the same document once per screen (each device) and once
 * per dock position used. The URL says which (`slayzone-preview`), and the file
 * handler injects the matching runtime at serve time, before anything paints:
 *
 * - screen: every `<slay-artifact-controls>` is hidden; actions the host relays
 *   arrive as a `slay:action` event on `window` (`event.detail = { action, value }`).
 * - controls (one position): only that position's controls show, moved up to
 *   `<body>` so they may sit anywhere in the markup. Clicks on `[data-action]`
 *   and input from named fields become `slay:action` events that bubble to the
 *   document, where the runtime sends them to the host. A page can dispatch the
 *   same event itself (`bubbles: true`) for custom widgets. The runtime reports
 *   its size so the dock fits the controls, and themes plain form controls with
 *   the app's tokens (sent with the ready message).
 *
 * The document's own scripts run in every copy. In a controls copy the screen is
 * hidden, not removed, so they still find their elements.
 */

import { HTML_PROTOTYPE_ACTION, HTML_PROTOTYPE_READY } from './html-prototype-actions'

export const ARTIFACT_CONTROLS_TAG = 'slay-artifact-controls'
export const ARTIFACT_CONTROLS_POSITIONS = ['top', 'bottom', 'left', 'right'] as const
export type ArtifactControlsPosition = (typeof ARTIFACT_CONTROLS_POSITIONS)[number]

export const ARTIFACT_PREVIEW_PARAM = 'slayzone-preview'
export const ARTIFACT_CONTROLS_PARAM = 'slayzone-controls'
export type ArtifactPreviewMode =
  | { kind: 'screen' }
  | { kind: 'controls'; position: ArtifactControlsPosition }

/** Controls frame → host: the size its controls need. */
export const ARTIFACT_CONTROLS_SIZE = 'slayzone:artifact-controls-size'

/** App theme variables the host sends a controls frame, as `--slz-<name>`. */
export const ARTIFACT_CONTROLS_THEME_TOKENS = [
  'foreground',
  'popover',
  'popover-foreground',
  'border',
  'accent',
  'accent-foreground',
  'primary',
  'primary-foreground',
  'ring'
] as const

/** Host → controls frame, once on load and whenever readiness changes. */
export interface ArtifactControlsReadyMessage {
  type: typeof HTML_PROTOTYPE_READY
  ready: boolean
  theme?: Partial<Record<(typeof ARTIFACT_CONTROLS_THEME_TOKENS)[number], string>> & {
    colorScheme?: 'light' | 'dark'
  }
}

const STYLE_ID = 'slz-artifact-controls-style'
const SCRIPT_ID = 'slz-artifact-controls-runtime'

/** A `position` attribute's value. Missing or unknown means bottom. */
export function controlsPosition(attr: string | null): ArtifactControlsPosition {
  const value = attr?.trim().toLowerCase()
  return ARTIFACT_CONTROLS_POSITIONS.find((p) => p === value) ?? 'bottom'
}

/** The docks a document needs, given its elements' `position` attributes. */
export function artifactControlsPositions(
  attrs: readonly (string | null)[]
): ArtifactControlsPosition[] {
  const used = new Set(attrs.map(controlsPosition))
  return ARTIFACT_CONTROLS_POSITIONS.filter((p) => used.has(p))
}

export function withArtifactPreviewMode(src: string, mode: ArtifactPreviewMode): string {
  const url = new URL(src)
  url.searchParams.set(ARTIFACT_PREVIEW_PARAM, mode.kind)
  if (mode.kind === 'controls') url.searchParams.set(ARTIFACT_CONTROLS_PARAM, mode.position)
  else url.searchParams.delete(ARTIFACT_CONTROLS_PARAM)
  return url.href
}

export function readArtifactPreviewMode(url: URL): ArtifactPreviewMode | null {
  const kind = url.searchParams.get(ARTIFACT_PREVIEW_PARAM)
  if (kind === 'screen') return { kind }
  if (kind !== 'controls') return null
  return { kind, position: controlsPosition(url.searchParams.get(ARTIFACT_CONTROLS_PARAM)) }
}

export function parseArtifactControlsSize(data: unknown): { width: number; height: number } | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, width, height } = data as Record<string, unknown>
  const size = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  return type === ARTIFACT_CONTROLS_SIZE && size(width) && size(height) ? { width, height } : null
}

const SCREEN_CSS = `${ARTIFACT_CONTROLS_TAG}{display:none!important}`

const SCREEN_SCRIPT = `(function(){
if(window.__slzArtifactControls)return;window.__slzArtifactControls=true;
var ACTION=${JSON.stringify(HTML_PROTOTYPE_ACTION)};
addEventListener('message',function(e){
if(e.source!==window.parent&&e.source!==window)return;
var d=e.data;if(!d||typeof d!=='object'||d.type!==ACTION||typeof d.action!=='string')return;
dispatchEvent(new CustomEvent('slay:action',{detail:{action:d.action,value:d.value}}));
});
})()`

const TAG = ARTIFACT_CONTROLS_TAG
const ACTIVE = `${TAG}[data-slz-active]`
const SIDE = ':where(html[data-slz-controls=left],html[data-slz-controls=right])'

// Fallbacks until the host's tokens arrive (and outside the app).
const CONTROLS_CSS = `:root{color-scheme:light dark;--slz-foreground:light-dark(#18181b,#fafafa);--slz-popover:light-dark(#fff,#232328);--slz-popover-foreground:var(--slz-foreground);--slz-border:light-dark(rgb(0 0 0/22%),rgb(255 255 255/16%));--slz-accent:light-dark(#e9e9eb,#2e2e34);--slz-accent-foreground:var(--slz-foreground);--slz-primary:light-dark(#18181b,#fafafa);--slz-primary-foreground:light-dark(#fafafa,#18181b);--slz-ring:#8a8a8f}
html,body{margin:0!important;padding:0!important;border:0!important;background:transparent!important;min-width:0!important;max-width:none!important;min-height:0!important;max-height:none!important;height:auto!important;overflow:hidden!important;display:block!important;transform:none!important}
body{visibility:hidden!important}
body>:not(${ACTIVE}),${TAG}:not([data-slz-active]){display:none!important}
${ACTIVE}{visibility:visible!important}
${SIDE} body{width:max-content!important}
:where(${TAG}){display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;padding:6px;box-sizing:border-box;font:12px/1.4 system-ui,sans-serif;color:var(--slz-foreground)}
${SIDE} :where(${TAG}){flex-direction:column;flex-wrap:nowrap;align-items:stretch;justify-content:flex-start}
:where(${TAG}) :where(button,select,input:not([type=checkbox],[type=radio],[type=range])){font:inherit;color:var(--slz-popover-foreground);background:var(--slz-popover);border:1px solid var(--slz-border);border-radius:6px;padding:3px 10px;min-height:24px;box-sizing:border-box}
:where(${TAG}) :where(button){border-radius:9999px;cursor:pointer}
:where(${TAG}) :where(button:hover){background:var(--slz-accent);color:var(--slz-accent-foreground)}
:where(${TAG}) :where(button,select,input):focus-visible{outline:2px solid var(--slz-ring);outline-offset:1px}
:where(${TAG}) :where(input,select){accent-color:var(--slz-primary)}
:where(${TAG}) :where(label){display:inline-flex;align-items:center;gap:6px}
html:not([data-slz-ready]) ${TAG}{pointer-events:none;opacity:.6}`

function controlsScript(position: ArtifactControlsPosition): string {
  return `(function(){
if(window.__slzArtifactControls)return;window.__slzArtifactControls=true;
var ACTION=${JSON.stringify(HTML_PROTOTYPE_ACTION)},READY=${JSON.stringify(HTML_PROTOTYPE_READY)},SIZE=${JSON.stringify(ARTIFACT_CONTROLS_SIZE)};
var TAG=${JSON.stringify(TAG)},POSITION=${JSON.stringify(position)},POSITIONS=${JSON.stringify(ARTIFACT_CONTROLS_POSITIONS)},TOKENS=${JSON.stringify(ARTIFACT_CONTROLS_THEME_TOKENS)};
var root=document.documentElement;root.setAttribute('data-slz-controls',POSITION);
function positionOf(el){var p=(el.getAttribute('position')||'').trim().toLowerCase();return POSITIONS.indexOf(p)>=0?p:'bottom'}
var sent='';
function measure(){var b=document.body;if(!b)return;var r=b.getBoundingClientRect(),w=Math.ceil(r.width),h=Math.ceil(r.height),k=w+'x'+h;if(k===sent)return;sent=k;window.parent.postMessage({type:SIZE,width:w,height:h},'*')}
function collect(){var b=document.body;if(!b)return;var all=document.querySelectorAll(TAG);
for(var i=0;i<all.length;i++){var el=all[i];if(positionOf(el)!==POSITION){el.removeAttribute('data-slz-active');continue}el.setAttribute('data-slz-active','');b.appendChild(el)}
measure()}
function isId(a){return typeof a==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(a)}
function isValue(v){return v===undefined||v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&isFinite(v))}
function inControls(el){return !!(el&&el.closest&&el.closest(TAG+'[data-slz-active]'))}
function emit(el,action,value){el.dispatchEvent(new CustomEvent('slay:action',{bubbles:true,detail:{action:action,value:value}}))}
document.addEventListener('slay:action',function(e){e.stopPropagation();var d=e.detail||{};
if(!isId(d.action)||!isValue(d.value)){console.warn('[slay-artifact-controls] ignored action: needs an id of letters, digits, - or _ and a string, number, boolean or null value',d);return}
var m={type:ACTION,action:d.action};if(d.value!==undefined)m.value=d.value;window.parent.postMessage(m,'*')});
document.addEventListener('click',function(e){if(e.defaultPrevented)return;var t=e.target&&e.target.closest?e.target.closest('[data-action]'):null;if(!t||!inControls(t))return;
var v=t.getAttribute('data-value');emit(t,t.getAttribute('data-action'),v===null?undefined:v)});
document.addEventListener('input',function(e){var el=e.target;if(!el||!el.name||!inControls(el)||el.hasAttribute('data-action'))return;
if(el.type==='radio'&&!el.checked)return;var v=el.type==='checkbox'?el.checked:(el.type==='number'||el.type==='range')?(isFinite(el.valueAsNumber)?el.valueAsNumber:null):el.value;emit(el,el.name,v)});
addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||typeof d!=='object'||d.type!==READY)return;
if(d.ready===true)root.setAttribute('data-slz-ready','');else root.removeAttribute('data-slz-ready');
var t=d.theme;if(!t||typeof t!=='object')return;
for(var i=0;i<TOKENS.length;i++){var v=t[TOKENS[i]];if(typeof v==='string'&&v.length<=200&&!/[;{}<>]/.test(v))root.style.setProperty('--slz-'+TOKENS[i],v)}
if(t.colorScheme==='light'||t.colorScheme==='dark')root.style.setProperty('color-scheme',t.colorScheme)});
function start(){collect();if(window.ResizeObserver&&document.body)new ResizeObserver(measure).observe(document.body);addEventListener('load',collect)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})()`
}

/** The stylesheet and script a mode injects. Exported for tests that run them. */
export function buildArtifactControlsRuntime(mode: ArtifactPreviewMode): {
  css: string
  script: string
} {
  return mode.kind === 'screen'
    ? { css: SCREEN_CSS, script: SCREEN_SCRIPT }
    : { css: CONTROLS_CSS, script: controlsScript(mode.position) }
}

const CONTROLS_TAG_RE = new RegExp(`<${TAG}[\\s/>]`, 'i')

/**
 * Serve-time injection, so a screen never paints its controls and a controls
 * frame never paints the screen. A screen without controls is returned as is.
 */
export function injectArtifactControlsRuntime(html: string, mode: ArtifactPreviewMode): string {
  if (mode.kind === 'screen' && !CONTROLS_TAG_RE.test(html)) return html
  const { css, script } = buildArtifactControlsRuntime(mode)
  // `</` would end the element early; the runtime never contains one.
  const block = `<style id="${STYLE_ID}">${css}</style><script id="${SCRIPT_ID}">${script}</script>`
  const headClose = html.search(/<\/head\s*>/i)
  if (headClose >= 0) return html.slice(0, headClose) + block + html.slice(headClose)
  // Never ahead of the doctype: that would put the page in quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return html.slice(0, at) + block + html.slice(at)
}
