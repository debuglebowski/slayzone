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
      INSERT INTO terminal_modes (id, label, type, initial_command, resume_command, default_flags, enabled, is_builtin, "order")
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `)

    const updateStmt = db.prepare(`
      UPDATE terminal_modes
      SET label = ?, type = ?, initial_command = ?, resume_command = ?, is_builtin = 1, updated_at = datetime('now')
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

    for (const mode of DEFAULT_TERMINAL_MODES) {
      if (!mode.isBuiltin) continue

      const existing = existsStmt.get(mode.id)
      if (existing) {
        // Update built-in mode to ensure templates/label match current code
        // (defaultFlags/enabled are left to user preference)
        updateStmt.run(
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.id
        )
      } else {
        // Add new built-in mode
        insertStmt.run(
          mode.id,
          mode.label,
          mode.type,
          mode.initialCommand ?? null,
          mode.resumeCommand ?? null,
          mode.defaultFlags ?? null,
          mode.enabled ? 1 : 0,
          mode.order
        )
      }
    }
  })()
}
