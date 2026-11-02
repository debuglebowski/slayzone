import { createHash } from 'node:crypto'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ProviderConfigEntry } from '@slayzone/terminal/runtime'

const chains = new WeakMap<SlayzoneDb, Map<string, Promise<unknown>>>()
function configHash(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sort(item)])
      )
    return v
  }
  return createHash('sha256')
    .update(JSON.stringify(sort(value)))
    .digest('hex')
}

/** One authority/revision per task/provider, independent of tab replay order. */
export function createHubProviderConfigStore(db: SlayzoneDb) {
  const pending = chains.get(db) ?? new Map<string, Promise<unknown>>()
  chains.set(db, pending)
  function serialize<T>(taskId: string, mode: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([taskId, mode])
    const next = (pending.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        if (pending.get(key) === next) pending.delete(key)
      })
    pending.set(key, next)
    return next
  }
  return {
    snapshot(taskId: string, mode: string) {
      return serialize(taskId, mode, async () => {
        const task = await db.get<{ provider_config: string | null }>(
          'SELECT provider_config FROM tasks WHERE id=?',
          [taskId]
        )
        if (!task) throw new Error('Chat task no longer exists')
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(task.provider_config ?? '{}') ?? {}
        } catch {
          /* Invalid legacy configuration is an empty baseline. */
        }
        const value: ProviderConfigEntry =
          parsed[mode] && typeof parsed[mode] === 'object' && !Array.isArray(parsed[mode])
            ? (parsed[mode] as ProviderConfigEntry)
            : {}
        const hash = configHash(value)
        await db.run(
          `INSERT INTO chat_provider_config_revisions(task_id,mode,revision,config_hash) VALUES(?,?,0,?)
          ON CONFLICT(task_id,mode) DO UPDATE SET revision=revision+CASE WHEN config_hash IS excluded.config_hash THEN 0 ELSE 1 END,config_hash=excluded.config_hash`,
          [taskId, mode, hash]
        )
        const revision = (await db.get<{ revision: number }>(
          'SELECT revision FROM chat_provider_config_revisions WHERE task_id=? AND mode=?',
          [taskId, mode]
        ))!.revision
        return { value, revision }
      })
    },
    apply(taskId: string, mode: string, key: string, value: unknown, revision = 0) {
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error('Invalid provider configuration revision')
      return serialize(taskId, mode, async () => {
        const known = await db.get<{ revision: number }>(
          'SELECT revision FROM chat_provider_config_revisions WHERE task_id=? AND mode=?',
          [taskId, mode]
        )
        if (known && revision < known.revision) return false
        const task = await db.get<{ provider_config: string | null }>(
          'SELECT provider_config FROM tasks WHERE id=?',
          [taskId]
        )
        if (!task) throw new Error('Chat task no longer exists')
        let config: Record<string, Record<string, unknown>> = {}
        try {
          config = JSON.parse(task.provider_config ?? '{}') ?? {}
        } catch {
          /* Old invalid configuration is normalized by the regular write path. */
        }
        const provider = {
          ...(config[mode] && typeof config[mode] === 'object' ? config[mode] : {}),
          [key]: value
        }
        const path = `$.${JSON.stringify(mode)}`
        await db.batchTxn([
          {
            type: 'run',
            sql: `UPDATE tasks SET provider_config=(SELECT json_set(json_set(cfg,?,CASE WHEN json_type(cfg,?)='object' THEN json(json_extract(cfg,?)) ELSE json('{}') END),?,json(?)) FROM (SELECT CASE WHEN json_valid(provider_config) THEN provider_config ELSE '{}' END cfg)) WHERE id=?`,
            params: [path, path, path, `${path}.${key}`, JSON.stringify(value), taskId]
          },
          {
            type: 'run',
            sql: `INSERT INTO chat_provider_config_revisions(task_id,mode,revision,config_hash) VALUES(?,?,?,?)
            ON CONFLICT(task_id,mode) DO UPDATE SET revision=excluded.revision,config_hash=excluded.config_hash`,
            params: [taskId, mode, revision, configHash(provider)]
          }
        ])
        return true
      })
    }
  }
}
