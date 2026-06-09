// cap-shell-2 — lazy singleton remotes for the four priority hosts.
//
// Mirrors the per-region getRemote() pattern from packages/webui/tasklist/src/mojo.ts.
// `Mojo` is injected by Chromium into every WebUI origin; its absence on module-eval
// (e.g. under Vitest or during SSR-style typecheck) is handled by fallback objects
// so the shim-factory never throws before the first method call.

import type {
  TasklistHostRemote,
  ProjectsHostRemote,
  TagsHostRemote,
  SettingsHostRemote,
  NativeDialogHostRemote,
  EmbeddedTabHostRemote,
  JsonRpcHostRemote,
  LayoutHostRemote,
} from '@slayzone/mojo-bindings'

let tasklistPromise: Promise<TasklistHostRemote> | null = null
let projectsPromise: Promise<ProjectsHostRemote> | null = null
let tagsPromise: Promise<TagsHostRemote> | null = null
let settingsPromise: Promise<SettingsHostRemote> | null = null
let nativeDialogPromise: Promise<NativeDialogHostRemote> | null = null
let embeddedTabPromise: Promise<EmbeddedTabHostRemote> | null = null
let jsonRpcPromise: Promise<JsonRpcHostRemote> | null = null
let layoutPromise: Promise<LayoutHostRemote> | null = null

function hasMojo(): boolean {
  return typeof globalThis !== 'undefined' && 'Mojo' in (globalThis as Record<string, unknown>)
}

export function hasMojoTransport(): boolean {
  return hasMojo()
}

export function tasklistRemote(): Promise<TasklistHostRemote> {
  if (!tasklistPromise) {
    tasklistPromise = import('@slayzone/mojo-bindings').then((m) => m.TasklistHost.getRemote())
  }
  return tasklistPromise
}

export function projectsRemote(): Promise<ProjectsHostRemote> {
  if (!projectsPromise) {
    projectsPromise = import('@slayzone/mojo-bindings').then((m) => m.ProjectsHost.getRemote())
  }
  return projectsPromise
}

export function tagsRemote(): Promise<TagsHostRemote> {
  if (!tagsPromise) {
    tagsPromise = import('@slayzone/mojo-bindings').then((m) => m.TagsHost.getRemote())
  }
  return tagsPromise
}

export function settingsRemote(): Promise<SettingsHostRemote> {
  if (!settingsPromise) {
    settingsPromise = import('@slayzone/mojo-bindings').then((m) => m.SettingsHost.getRemote())
  }
  return settingsPromise
}

export function nativeDialogRemote(): Promise<NativeDialogHostRemote> {
  if (!nativeDialogPromise) {
    nativeDialogPromise = import('@slayzone/mojo-bindings').then((m) => m.NativeDialogHost.getRemote())
  }
  return nativeDialogPromise
}

export function embeddedTabRemote(): Promise<EmbeddedTabHostRemote> {
  if (!embeddedTabPromise) {
    embeddedTabPromise = import('@slayzone/mojo-bindings').then((m) => m.EmbeddedTabHost.getRemote())
  }
  return embeddedTabPromise
}

export function jsonRpcRemote(): Promise<JsonRpcHostRemote> {
  if (!jsonRpcPromise) {
    jsonRpcPromise = import('@slayzone/mojo-bindings').then((m) => m.JsonRpcHost.getRemote())
  }
  return jsonRpcPromise
}

export function layoutRemote(): Promise<LayoutHostRemote> {
  if (!layoutPromise) {
    layoutPromise = import('@slayzone/mojo-bindings').then((m) => m.LayoutHost.getRemote())
  }
  return layoutPromise
}

// cap-layout-p4 — raise/clear the native overlay surface (LayoutHost.ShowOverlay).
// `setNativeOverlay('dialog')` shows the shell-rendered dialog surface above the
// live embedded tab; `setNativeOverlay('')` closes the active overlay. Resolves
// false when the id is unknown or no transport/BrowserView is available.
export async function setNativeOverlay(overlayId: string): Promise<boolean> {
  if (!hasMojo()) return false
  try {
    const remote = await layoutRemote()
    const { ok } = await remote.showOverlay(overlayId)
    return ok
  } catch {
    return false
  }
}

// JsonRpcHost escape hatch — long-tail shims (fs, feedback, cli-install,
// changelog, search, …) reach sidecar handlers without per-method mojom
// plumbing. Params are JSON-serialized; result envelope is unwrapped.
//
// Three call shapes are accepted, corresponding to the two distinct wire
// encodings `SlayzoneJsonRpcHost::Call` understands (see
// chromium/src/chrome/browser/slayzone/slayzone_json_rpc_host.cc:80-95):
//
//   jsonRpcCall('method', [a, b, c])              → positional args.
//   jsonRpcCall('method', { params: [a, b, c] }) → positional args (legacy).
//     Both stringify the array; C++ wraps it as {params: [...]}; sidecar
//     registry unpacks back to handler(a, b, c).
//   jsonRpcCall('method', { projectId: 'x' })    → single-arg object.
//     Stringifies the object; C++ passes dict through unchanged; sidecar
//     registry sees an object-shaped `request.params` and wraps it as a
//     single positional arg (registry.ts:106). Handler reads
//     `params[0].projectId`.
//
// The third form is what every "typed write" shim uses
// (`projects:create`, `projects:set-active`, `tasks:update-meta`, …).
// Serializing the object as a list was the old bug — it produced `[]`
// on the wire because `Array.isArray(request)` was false and the fallback
// `request.params ?? []` missed.
export async function jsonRpcCall<T = unknown>(
  method: string,
  request: { params: unknown[] } | unknown[] | Record<string, unknown> = { params: [] },
): Promise<T> {
  let serialized: string
  if (Array.isArray(request)) {
    serialized = JSON.stringify(request)
  } else if (
    request &&
    typeof request === 'object' &&
    'params' in request &&
    Array.isArray((request as { params: unknown }).params)
  ) {
    serialized = JSON.stringify((request as { params: unknown[] }).params)
  } else if (request && typeof request === 'object') {
    serialized = JSON.stringify(request)
  } else {
    serialized = '[]'
  }
  const remote = await jsonRpcRemote()
  const { result } = await remote.call(method, serialized)
  if (!result.ok) {
    throw new Error(result.error || `jsonRpcCall(${method}) failed`)
  }
  return (result.resultJson ? JSON.parse(result.resultJson) : undefined) as T
}
