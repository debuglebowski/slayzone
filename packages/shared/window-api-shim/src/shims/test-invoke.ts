// cap-shell-16 — window.__testInvoke shim.
//
// The Electron preload exposes a generic `ipcRenderer.invoke(channel, ...args)`
// gate under `window.__testInvoke` when PLAYWRIGHT=1. Shell mode has no IPC;
// we route test-only channels to the sidecar's JSON-RPC surface instead.
//
// Routing table (see packages/sidecar/src/handlers/export-import.ts):
//   export-import:test:export-all-to-path     → sidecar
//   export-import:test:export-project-to-path → sidecar
//   export-import:test:import-from-path       → sidecar
//   export-import:test:set-task-parent        → sidecar
//   app:reset-for-test                        → noop (shell already resets via
//                                               chromium-shell fixture's
//                                               `resetApp`; kept as stub for
//                                               spec compatibility)
//   integrations:test:*                       → sidecar (cap-followup-github-
//                                               project-settings sub-cap D,
//                                               worker AV — co-registered
//                                               with sub-cap A's read
//                                               handlers so the mock-state
//                                               Maps are shared)
//   browser:get-url                           → CDP-route bridge (BM,
//                                               2026-04-26). Test fixture
//                                               exposes
//                                               `__slayzoneCdpEmbeddedTargets`;
//                                               we pick the non-shell page
//                                               target. Single-view smoke
//                                               only — multi-view needs
//                                               viewId→targetId mapping and
//                                               is left to the next cap.
//                                               No-op fallback returns null
//                                               (matches Electron stub when
//                                               WebContents not found).
//   anything else                             → jsonRpcCall forward (params
//                                               as positional array)

import { jsonRpcCall } from '../transport/mojo'

type CdpEmbeddedTargets =
  | Array<{ targetId: string; url: string }>
  | { error: string }

type CdpEvalResult = unknown | { error: string } | null

async function routeBrowserGetUrl(args: readonly unknown[]): Promise<string | null> {
  const target = globalThis as unknown as {
    __slayzoneCdpEmbeddedTargets?: () => Promise<CdpEmbeddedTargets>
  }
  const fn = target.__slayzoneCdpEmbeddedTargets
  if (typeof fn !== 'function') return null
  const result = await fn()
  if (!Array.isArray(result) || result.length === 0) return null
  // Single-view smoke: first non-shell page target wins. Multi-view callers
  // get the first registered embedded target — documented caveat in the
  // BM bail-doc. ViewId is `args[0]` but unused in the smoke path because
  // the shim's view registry is in a sibling module; cross-module wiring is
  // the multi-view follow-up.
  void args
  return result[0]?.url ?? null
}

async function evaluateOnEmbedded(expression: string): Promise<CdpEvalResult> {
  const target = globalThis as unknown as {
    __slayzoneCdpEvaluateOnEmbedded?: (expression: string) => Promise<CdpEvalResult>
  }
  const fn = target.__slayzoneCdpEvaluateOnEmbedded
  if (typeof fn !== 'function') return null
  return fn(expression).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }))
}

function isCdpErr(v: CdpEvalResult): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in (v as Record<string, unknown>)
}

// DF (2026-04-26) — direct __testInvoke routes for the four lever-1
// scripting host methods. These mirror the shim's `window.api.browser.*`
// implementations; specs can reach the CDP-route bridge through either
// path. Multi-view caveat inherited from BM's get-url route.
async function routeBrowserExecuteJs(args: readonly unknown[]): Promise<unknown> {
  const code = String(args[1] ?? '')
  const expr = `(function(){ return (function(){ ${code} })(); })()`
  const r = await evaluateOnEmbedded(expr)
  if (r === null || isCdpErr(r)) return undefined
  return r
}

async function routeBrowserInsertCss(args: readonly unknown[]): Promise<string> {
  const css = String(args[1] ?? '')
  const key = 'slay-css-' + Math.random().toString(36).slice(2, 10)
  const expr =
    '(function(){' +
    `var s=document.createElement('style');s.id=${JSON.stringify(key)};` +
    `s.textContent=${JSON.stringify(css)};` +
    'document.head.appendChild(s);return s.id;})()'
  const r = await evaluateOnEmbedded(expr)
  return typeof r === 'string' ? r : ''
}

async function routeBrowserRemoveCss(args: readonly unknown[]): Promise<null> {
  const key = String(args[1] ?? '')
  const expr =
    '(function(){' +
    `var el=document.getElementById(${JSON.stringify(key)});` +
    'if(el)el.remove();return true;})()'
  await evaluateOnEmbedded(expr)
  return null
}

async function routeBrowserSetZoom(args: readonly unknown[]): Promise<null> {
  const factor = Number(args[1] ?? 1)
  const expr = `(function(){document.body.style.zoom=${factor};return document.body.style.zoom;})()`
  await evaluateOnEmbedded(expr)
  return null
}

async function route(channel: string, args: readonly unknown[]): Promise<unknown> {
  if (channel === 'app:reset-for-test') return { ok: true }
  if (channel === 'browser:get-url') return routeBrowserGetUrl(args)
  if (channel === 'browser:execute-js') return routeBrowserExecuteJs(args)
  if (channel === 'browser:insert-css') return routeBrowserInsertCss(args)
  if (channel === 'browser:remove-css') return routeBrowserRemoveCss(args)
  if (channel === 'browser:set-zoom') return routeBrowserSetZoom(args)
  return jsonRpcCall(channel, { params: args })
}

export function installTestInvoke(): void {
  const target = globalThis as unknown as {
    __testInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
    __testEmit?: (channel: string, data: unknown) => void
  }
  target.__testInvoke = (channel, ...args) => route(channel, args)
  target.__testEmit = (channel, data) => {
    // Mirror the Electron preload's test-only event dispatch — some specs
    // rely on this to simulate main→renderer IPC pushes. In shell mode the
    // browser-internal emit isn't observable, but dispatching a DOM
    // CustomEvent is a superset for the assertions we carry.
    try {
      window.dispatchEvent(new CustomEvent(channel, { detail: data }))
    } catch {
      /* jsdom / non-DOM host — ignore */
    }
  }
}
