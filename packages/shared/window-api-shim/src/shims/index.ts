import type { _LegacyElectronAPI as ElectronAPI } from '@slayzone/types'
import { dbShim } from './db'
import { settingsShim } from './settings'
import { themeShim } from './theme'
import { diagnosticsShim } from './diagnostics'
import { appShim } from './app'
import { ptyShim } from './pty'
import { dialogShim } from './dialog'
import { browserShim } from './browser'
import { webviewShim } from './webview'
import { terminalModesShim } from './terminalModes'
import { tabsShim } from './tabs'
import { makeStubNamespace } from './stub-factory'

// Every ElectronAPI namespace not listed under REAL/MINIMAL below routes
// through the recursive stub-factory so the shell never throws on access.
// Order matters only in one direction: assembled stubs are spread first,
// then overridden by the explicit shims.
//
// `git`/`aiConfig`/`fs`/`files`/`taskDependencies`/`feedback`/`assets`/
// `assetFolders`/`tags`/`taskTags`/`integrations` joined this list in the
// window-api-shim dead-code cleanup (web-access plan open question #4):
// their shim files routed EVERY method through `jsonRpcCall`, which forwards
// to `packages/apps/hub/src/sidecar-socket.ts` — a hardcoded 3-method
// dispatch (`sidecar.hello`/`sidecar.ping`/`auth:deep-link`) that rejects
// anything else with -32601, confirmed by tracing the full C++→socket chain
// (chromium/.../sidecar_client.cc → sidecar-socket.ts's `default:` branch).
// Every exported method in those ~1,800 lines was unreachable dead code —
// it always threw, never a real implementation degrading gracefully — so
// folding them into the SAME stub treatment every other not-yet-wired
// namespace already gets is strictly more correct, not just smaller.
//
// `db` is NOT here: it mixes genuinely-alive Mojo-remote calls
// (`deleteProject`, `deleteTask`, `listTags` internals) with dead
// `jsonRpcCall` ones — left untouched this pass; see db.ts's own comments.
const STUBBED_NAMESPACES = [
  'taskTemplates',
  'history',
  'shortcuts',
  'shell',
  'auth',
  'floatingAgent',
  'window',
  'telemetry',
  'screenshot',
  'leaderboard',
  'usage',
  'exportImport',
  'processes',
  'backup',
  'testPanel',
  'automations',
  'usageAnalytics',
  'git',
  'aiConfig',
  'fs',
  'files',
  'taskDependencies',
  'feedback',
  'assets',
  'assetFolders',
  'tags',
  'taskTags',
  'integrations'
] as const

export function buildApi(): ElectronAPI {
  const api: Record<string, unknown> = {}
  for (const ns of STUBBED_NAMESPACES) {
    api[ns] = makeStubNamespace(ns)
  }
  api.db = dbShim
  api.settings = settingsShim
  api.theme = themeShim
  api.diagnostics = diagnosticsShim
  api.app = appShim
  api.pty = ptyShim
  api.dialog = dialogShim
  api.browser = browserShim
  api.webview = webviewShim
  api.terminalModes = terminalModesShim
  api.tabs = tabsShim
  return api as unknown as ElectronAPI
}
