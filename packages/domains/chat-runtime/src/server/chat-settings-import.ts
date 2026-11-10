/**
 * Hand-off kind of an owned chat's settings (robustness plan §9, decision 2; hub
 * migration v205): the permission mode, model, effort, collaboration and fast mode
 * the hub still held for a chat a computer owns. The hub's copy is gone after v205;
 * the computer may not have held every setting (a production copy had an active
 * chat with no configuration here, so its auto-accept mode would have been lost).
 *
 * Only a setting this computer LACKS is taken: its own values are newer. With no
 * configuration here yet, the settings wait as the seed the first read of it starts
 * from (`provider_config_seeds`, applied in local-data `providerState`). Idempotent.
 *
 * @module chat-runtime/server/chat-settings-import
 */
import { z } from 'zod'
import type { DataImportKind } from './task-data'

const settings = z
  .object({
    chatMode: z.string().min(1).max(200).optional(),
    chatModel: z.string().min(1).max(500).optional(),
    chatEffort: z.string().min(1).max(200).optional(),
    chatCollaboration: z.enum(['default', 'plan']).optional(),
    chatFastMode: z.boolean().optional()
  })
  .strict()
  .refine((s) => Object.keys(s).length > 0, 'no settings')

const value = z.object({ mode: z.string().min(1).max(200), settings })

export const chatSettingsImport: DataImportKind<z.infer<typeof value>> = {
  value,
  apply(storage, item) {
    const { mode, settings: hub } = item.value
    storage.compose((db) => {
      const current = db
        .prepare('SELECT value, revision FROM provider_configs WHERE task_id=? AND mode=?')
        .get(item.taskId, mode) as { value: string; revision: number } | undefined
      if (current) {
        const local = JSON.parse(current.value) as Record<string, unknown>
        const next = { ...local }
        for (const [key, v] of Object.entries(hub)) if (!(key in next)) next[key] = v
        if (Object.keys(next).length === Object.keys(local).length) return
        db.prepare(
          'UPDATE provider_configs SET value=?, revision=? WHERE task_id=? AND mode=?'
        ).run(JSON.stringify(next), current.revision + 1, item.taskId, mode)
        return
      }
      const seed = db
        .prepare('SELECT value FROM provider_config_seeds WHERE task_id=? AND mode=?')
        .get(item.taskId, mode) as { value: string } | undefined
      const merged = {
        ...hub,
        ...(seed ? (JSON.parse(seed.value) as Record<string, unknown>) : {})
      }
      db.prepare(
        `INSERT INTO provider_config_seeds(task_id, mode, value) VALUES(?,?,?)
         ON CONFLICT(task_id, mode) DO UPDATE SET value=excluded.value`
      ).run(item.taskId, mode, JSON.stringify(merged))
    })
  }
}
