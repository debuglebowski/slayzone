import type { Database } from 'better-sqlite3'
import { DEFAULT_TERMINAL_MODES } from '../shared/types'

/**
 * Synchronize terminal modes in the database with the default modes defined in code.
 * This ensures that new built-in modes are added and existing ones are updated
 * across app versions, while preserving user-added custom modes.
 */
export function syncTerminalModes(db: Database): void {
  db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT INTO terminal_modes (id, label, type, command, args, enabled, is_builtin, "order")
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `)

    const updateStmt = db.prepare(`
      UPDATE terminal_modes 
      SET label = ?, type = ?, command = ?, is_builtin = 1, updated_at = datetime('now')
      WHERE id = ?
    `)

    const existsStmt = db.prepare('SELECT id FROM terminal_modes WHERE id = ?')

    // Prune legacy built-ins that are no longer in the code definition
    const builtinIds = DEFAULT_TERMINAL_MODES.map(m => m.id)
    const placeholders = builtinIds.map(() => '?').join(',')
    db.prepare(`
      DELETE FROM terminal_modes 
      WHERE is_builtin = 1 AND id NOT IN (${placeholders})
    `).run(...builtinIds)

    // Manual cleanup for "terminal" since it's now entirely code-side
    db.prepare('DELETE FROM terminal_modes WHERE id = ?').run('terminal')

    for (const mode of DEFAULT_TERMINAL_MODES) {
      if (!mode.isBuiltin) continue

      const existing = existsStmt.get(mode.id)
      if (existing) {
        // Update built-in mode to ensure command/label match current code
        // (Args/Enabled are left to user preference)
        updateStmt.run(
          mode.label,
          mode.type,
          mode.command ?? null,
          mode.id
        )
      } else {
        // Add new built-in mode
        insertStmt.run(
          mode.id,
          mode.label,
          mode.type,
          mode.command ?? null,
          mode.args ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        )
      }
    }
  })()
}
