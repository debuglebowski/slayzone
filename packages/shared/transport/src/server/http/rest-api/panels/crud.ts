import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Express } from 'express'
import { SettingsService, type SettingsView } from '@slayzone/settings/server'
import type { PanelConfig, WebPanelDefinition } from '@slayzone/task/shared'
import {
  DEFAULT_PANEL_CONFIG,
  inferHostScopeFromUrl,
  inferProtocolFromUrl,
  isPanelEnabled,
  mergePredefinedWebPanels,
  normalizeDesktopProtocol,
  validatePanelShortcut
} from '@slayzone/task/shared'
import type { RestApiDeps } from '../types'
import { restPrincipalOf } from '../principal'

/**
 * Web-panel management (the `panel_config` settings blob).
 * Mirrors `slay panels` (cli/src/commands/panels.ts):
 *
 * - GET    /api/panels                → configured web panels
 * - POST   /api/panels   { name, url, shortcut?, blockHandoff?, protocol? }
 * - PATCH  /api/panels/:idOrName  { enabled: boolean }  (task-view visibility)
 * - DELETE /api/panels/:idOrName      (predefined panels are tombstoned)
 *
 * `panel_config` is a per-user setting (T-16, `settingScope`): the caller's own
 * copy when the request carries a user, the global row on a hub without login —
 * the same row the app's settings router serves that caller.
 */

function panelSettings(deps: RestApiDeps, req: IncomingMessage): SettingsView {
  return SettingsService.forDatabase(deps.db).forUser(restPrincipalOf(req)?.userId ?? null)
}

async function loadPanelConfig(settings: SettingsView): Promise<PanelConfig> {
  const value = await settings.get('panel_config')
  if (!value) return { ...DEFAULT_PANEL_CONFIG }
  try {
    return mergePredefinedWebPanels(JSON.parse(value) as PanelConfig)
  } catch {
    return { ...DEFAULT_PANEL_CONFIG }
  }
}

async function savePanelConfig(settings: SettingsView, config: PanelConfig): Promise<void> {
  await settings.set('panel_config', JSON.stringify(config))
}

function findPanel(config: PanelConfig, idOrName: string): WebPanelDefinition | undefined {
  return config.webPanels.find(
    (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase()
  )
}

export function registerPanelsCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/panels', async (req, res) => {
    try {
      const config = await loadPanelConfig(panelSettings(deps, req))
      // Augment each panel with its task-view enabled state (additive) so the
      // CLI's `slay panels list` can render the ON column without a 2nd fetch.
      const data = config.webPanels.map((p) => ({
        ...p,
        enabled: isPanelEnabled(config, p.id, 'task')
      }))
      res.json({ ok: true, data })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/panels', async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      url?: unknown
      shortcut?: unknown
      blockHandoff?: unknown
      protocol?: unknown
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ ok: false, error: 'Panel name is required.' })
      return
    }
    if (typeof body.url !== 'string' || !body.url.trim()) {
      res.status(400).json({ ok: false, error: 'url required' })
      return
    }
    const blockHandoff = body.blockHandoff === true
    if (body.protocol !== undefined && !blockHandoff) {
      res.status(400).json({ ok: false, error: 'protocol requires blockHandoff' })
      return
    }

    let url = body.url.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`

    try {
      const settings = panelSettings(deps, req)
      const config = await loadPanelConfig(settings)

      const shortcut = typeof body.shortcut === 'string' ? body.shortcut : undefined
      if (shortcut) {
        const err = validatePanelShortcut(shortcut, config.webPanels)
        if (err) {
          res.status(400).json({ ok: false, error: err })
          return
        }
      }

      let handoffProtocol: string | undefined
      let handoffHostScope: string | undefined
      if (blockHandoff) {
        const resolvedProtocol =
          normalizeDesktopProtocol(typeof body.protocol === 'string' ? body.protocol : null) ??
          inferProtocolFromUrl(url)
        if (!resolvedProtocol) {
          res.status(400).json({
            ok: false,
            error: 'Could not determine handoff protocol. Pass protocol to specify.'
          })
          return
        }
        handoffProtocol = resolvedProtocol
        handoffHostScope = inferHostScopeFromUrl(url) ?? undefined
      }

      const newPanel: WebPanelDefinition = {
        id: `web:${randomUUID().slice(0, 8)}`,
        name: body.name.trim(),
        baseUrl: url,
        shortcut: shortcut?.trim().toLowerCase() || undefined,
        blockDesktopHandoff: blockHandoff || undefined,
        handoffProtocol,
        handoffHostScope
      }

      await savePanelConfig(settings, { ...config, webPanels: [...config.webPanels, newPanel] })
      deps.notifyRenderer()
      res.json({ ok: true, data: newPanel })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // Enable/disable a panel in the task view (`viewEnabled.task[id]`).
  app.patch('/api/panels/:idOrName', async (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ ok: false, error: 'enabled (boolean) required' })
      return
    }
    try {
      const settings = panelSettings(deps, req)
      const config = await loadPanelConfig(settings)
      const panel = findPanel(config, req.params.idOrName)
      if (!panel) {
        res.status(404).json({ ok: false, error: `Panel not found: ${req.params.idOrName}` })
        return
      }
      await savePanelConfig(settings, {
        ...config,
        viewEnabled: {
          ...config.viewEnabled,
          task: { ...config.viewEnabled?.task, [panel.id]: body.enabled }
        }
      })
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: panel.id, name: panel.name, enabled: body.enabled } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/panels/:idOrName', async (req, res) => {
    try {
      const settings = panelSettings(deps, req)
      const config = await loadPanelConfig(settings)
      const panel = findPanel(config, req.params.idOrName)
      if (!panel) {
        res.status(404).json({ ok: false, error: `Panel not found: ${req.params.idOrName}` })
        return
      }

      const next: PanelConfig = {
        ...config,
        webPanels: config.webPanels.filter((p) => p.id !== panel.id)
      }
      if (panel.predefined) {
        next.deletedPredefined = [...(config.deletedPredefined ?? []), panel.id]
      }

      await savePanelConfig(settings, next)
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: panel.id, name: panel.name } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
