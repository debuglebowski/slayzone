import type { SlayzoneDb } from '@slayzone/platform'
import { settingRule } from '../shared/registry'
import { POLICY_LOCK_PREFIX, settingScope } from './scope'

/**
 * A project's own value for a hub setting (plans/settings-by-scope.md, phase 3).
 *
 * Hub settings are defaults for everything that runs on the hub; a project may
 * replace some of them for itself. The value that applies to a project's work is
 * `project_settings` → `settings` (the hub's) → the reader's built-in default.
 * Every server reader of an overridable key goes through `readEffectiveSetting`, so
 * an override reaches task create, the chat spawn and agent startup alike.
 */

/** A hub key a project may set its own value for (registry `projectOverride`). */
export function isProjectOverridable(key: string): boolean {
  return settingRule(key)?.projectOverride === true && settingScope(key) === 'hub'
}

export type SettingSource = 'project' | 'hub' | 'default'

export interface EffectiveSetting {
  /** Null when neither the project nor the hub has one: the reader's default applies. */
  value: string | null
  source: SettingSource
  /** The hub locks this setting (phase 6): projects cannot use their own value. */
  locked?: boolean
}

/** Whether the hub locks `key` for projects (`policy_lock:<key>`). */
export async function isLockedForProjects(db: SlayzoneDb, key: string): Promise<boolean> {
  const row = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    POLICY_LOCK_PREFIX + key
  ])
  return row?.value === '1'
}

/**
 * The value of hub setting `key` for work in `projectId` (none: the hub's own).
 * A key that is not overridable reads the hub's value whatever the project.
 */
export async function readEffectiveSetting(
  db: SlayzoneDb,
  key: string,
  projectId?: string | null
): Promise<EffectiveSetting> {
  const locked = isProjectOverridable(key) && (await isLockedForProjects(db, key))
  if (projectId && isProjectOverridable(key) && !locked) {
    const own = await db.get<{ value: string }>(
      'SELECT value FROM project_settings WHERE project_id = ? AND key = ?',
      [projectId, key]
    )
    if (own) return { value: own.value, source: 'project' }
  }
  const hub = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  const lock = locked ? { locked: true } : {}
  return hub
    ? { value: hub.value, source: 'hub', ...lock }
    : { value: null, source: 'default', ...lock }
}

/** `readEffectiveSetting(...).value`, for readers that only need the value. */
export async function readEffectiveSettingValue(
  db: SlayzoneDb,
  key: string,
  projectId?: string | null
): Promise<string | null> {
  return (await readEffectiveSetting(db, key, projectId)).value
}

/** Every override a project holds, keyed by setting key. */
export async function listProjectOverrides(
  db: SlayzoneDb,
  projectId: string
): Promise<Record<string, string>> {
  const rows = await db.all<{ key: string; value: string }>(
    'SELECT key, value FROM project_settings WHERE project_id = ?',
    [projectId]
  )
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

/** Every project on this hub that overrides `key`, with its value. */
export async function listOverridesOfKey(
  db: SlayzoneDb,
  key: string
): Promise<Array<{ projectId: string; value: string }>> {
  return db.all<{ projectId: string; value: string }>(
    'SELECT project_id AS projectId, value FROM project_settings WHERE key = ?',
    [key]
  )
}

export class NotOverridableError extends Error {
  constructor(key: string, reason = 'cannot override') {
    super(`A project ${reason} "${key}"`)
    this.name = 'NotOverridableError'
  }
}

export async function setProjectOverride(
  db: SlayzoneDb,
  projectId: string,
  key: string,
  value: string
): Promise<void> {
  if (!isProjectOverridable(key)) throw new NotOverridableError(key)
  if (await isLockedForProjects(db, key))
    throw new NotOverridableError(key, 'cannot override (locked by the hub)')
  await db.run(
    `INSERT INTO project_settings (project_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value`,
    [projectId, key, value]
  )
}

export async function clearProjectOverride(
  db: SlayzoneDb,
  projectId: string,
  key: string
): Promise<void> {
  await db.run('DELETE FROM project_settings WHERE project_id = ? AND key = ?', [projectId, key])
}
