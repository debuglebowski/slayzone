import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PanelConfig, WebPanelDefinition } from '@slayzone/task/shared'
import {
  DEFAULT_PANEL_CONFIG,
  inferHostScopeFromUrl,
  inferProtocolFromUrl,
  mergePredefinedWebPanels,
  normalizeDesktopProtocol,
  validatePanelShortcut
} from '@slayzone/task/shared'
import type { RestApiDeps } from '../types'

/**
 * Web-panel management (the `panel_config` settings blob).
 * Mirrors `slay panels` (cli/src/commands/panels.ts):
 *
 * - GET    /api/panels                → configured web panels
 * - POST   /api/panels   { name, url, shortcut?, blockHandoff?, protocol? }
 * - DELETE /api/panels/:idOrName      (predefined panels are tombstoned)
 */

async function loadPanelConfig(db: SlayzoneDb): Promise<PanelConfig> {
  const row = await db.get<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'panel_config' LIMIT 1`
  )
  if (!row?.value) return { ...DEFAULT_PANEL_CONFIG }
  try {
    return mergePredefinedWebPanels(JSON.parse(row.value) as PanelConfig)
  } catch {
    return { ...DEFAULT_PANEL_CONFIG }
  }
}

async function savePanelConfig(db: SlayzoneDb, config: PanelConfig): Promise<void> {
  await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [
    'panel_config',
    JSON.stringify(config)
  ])
}

function findPanel(config: PanelConfig, idOrName: string): WebPanelDefinition | undefined {
  return config.webPanels.find(
    (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase()
  )
}

export function registerPanelsCrudRoutes(app: Express, deps: RestApiDeps): void {
  app.get('/api/panels', async (_req, res) => {
    try {
      const config = await loadPanelConfig(deps.db)
      res.json({ ok: true, data: config.webPanels })
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
      const config = await loadPanelConfig(deps.db)

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

      await savePanelConfig(deps.db, { ...config, webPanels: [...config.webPanels, newPanel] })
      deps.notifyRenderer()
      res.json({ ok: true, data: newPanel })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/panels/:idOrName', async (req, res) => {
    try {
      const config = await loadPanelConfig(deps.db)
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

      await savePanelConfig(deps.db, next)
      deps.notifyRenderer()
      res.json({ ok: true, data: { id: panel.id, name: panel.name } })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
