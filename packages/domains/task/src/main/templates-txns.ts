import type { Database } from 'better-sqlite3'

/**
 * Named-transaction adapters for task templates.
 *
 * `create` is a conditional read-modify-write — it (optionally) clears the
 * project's existing default, reads MAX(sort_order), THEN inserts at +1 — so it
 * can't be a static `batchTxn` op list and must run as one function inside the
 * DB worker.
 *
 * Pure: imports only the better-sqlite3 type — safe for the worker bundle. The
 * returned row is structured-cloneable; the IPC layer parses it via
 * `parseTemplate` after the call.
 */

export interface CreateTemplateTxnParams {
  id: string
  projectId: string
  name: string
  description: string | null
  terminalMode: string | null
  // Pre-serialized JSON (or null) — the IPC layer stringifies before sending.
  providerConfig: string | null
  panelVisibility: string | null
  browserTabs: string | null
  webPanelUrls: string | null
  dangerouslySkipPermissions: number | null
  defaultStatus: string | null
  defaultPriority: number | null
  isDefault: number
}

export const templatesTxns = {
  'task-templates:create': (
    db: Database,
    p: CreateTemplateTxnParams
  ): Record<string, unknown> | undefined => {
    // If marking as default, clear existing default for this project
    if (p.isDefault) {
      db.prepare(
        'UPDATE task_templates SET is_default = 0 WHERE project_id = ? AND is_default = 1'
      ).run(p.projectId)
    }
    const maxOrder =
      (
        db
          .prepare('SELECT MAX(sort_order) as m FROM task_templates WHERE project_id = ?')
          .get(p.projectId) as { m: number | null }
      )?.m ?? -1

    db.prepare(`
      INSERT INTO task_templates (
        id, project_id, name, description,
        terminal_mode, provider_config, panel_visibility, browser_tabs, web_panel_urls,
        dangerously_skip_permissions, default_status, default_priority,
        is_default, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      p.id,
      p.projectId,
      p.name,
      p.description,
      p.terminalMode,
      p.providerConfig,
      p.panelVisibility,
      p.browserTabs,
      p.webPanelUrls,
      p.dangerouslySkipPermissions,
      p.defaultStatus,
      p.defaultPriority,
      p.isDefault,
      maxOrder + 1
    )
    return db.prepare('SELECT * FROM task_templates WHERE id = ?').get(p.id) as
      | Record<string, unknown>
      | undefined
  }
}
