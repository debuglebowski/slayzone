import type { ElectronAPI } from '@slayzone/types'
import { dbShim } from './db'
import { tagsShim, taskTagsShim } from './tags'
import { settingsShim } from './settings'
import { themeShim } from './theme'
import { diagnosticsShim } from './diagnostics'
import { appShim } from './app'
import { ptyShim } from './pty'
import { dialogShim } from './dialog'
import { integrationsShim } from './integrations'
import { browserShim } from './browser'
import { webviewShim } from './webview'
import { terminalModesShim } from './terminalModes'
import { tabsShim } from './tabs'
import { gitShim } from './git'
import { aiConfigShim } from './aiConfig'
import { fsShim } from './fs'
import { filesShim } from './files'
import { taskDependenciesShim } from './taskDependencies'
import { feedbackShim } from './feedback'
import { assetsShim, assetFoldersShim } from './assets'
import { makeStubNamespace } from './stub-factory'

// Every ElectronAPI namespace not listed under REAL/MINIMAL below routes
// through the recursive stub-factory so the shell never throws on access.
// Order matters only in one direction: assembled stubs are spread first,
// then overridden by the explicit shims.
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
] as const

export function buildApi(): ElectronAPI {
  const api: Record<string, unknown> = {}
  for (const ns of STUBBED_NAMESPACES) {
    api[ns] = makeStubNamespace(ns)
  }
  api.db = dbShim
  api.tags = tagsShim
  api.taskTags = taskTagsShim
  api.settings = settingsShim
  api.theme = themeShim
  api.diagnostics = diagnosticsShim
  api.app = appShim
  api.pty = ptyShim
  api.dialog = dialogShim
  api.integrations = integrationsShim
  api.browser = browserShim
  api.webview = webviewShim
  api.terminalModes = terminalModesShim
  api.tabs = tabsShim
  api.git = gitShim
  api.aiConfig = aiConfigShim
  api.fs = fsShim
  api.files = filesShim
  api.taskDependencies = taskDependenciesShim
  api.feedback = feedbackShim
  api.assets = assetsShim
  api.assetFolders = assetFoldersShim
  return api as unknown as ElectronAPI
}
