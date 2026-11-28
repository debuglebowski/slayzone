import type { SlayzoneDb } from '@slayzone/platform'
import type { PushKind, PushPrefs } from '../index'

/**
 * The phones each user signed in with on this hub (`push_devices`, v228). `user` is the
 * signed-in user's id, or '' on a hub without login (one person). A phone is named by
 * its own `deviceId`; its Expo token belongs to one row at most, so a phone that signs
 * in as someone else takes its token with it.
 */

export interface PushDeviceRegistration {
  deviceId: string
  token: string
  /** The phone's own name for this hub, echoed in every notification's data. */
  hubRef: string
}

export interface PushRecipient {
  token: string
  hubRef: string
}

/** Adds the phone or refreshes its token and hub name; its prefs are kept. */
export async function registerDevice(
  db: SlayzoneDb,
  user: string,
  device: PushDeviceRegistration
): Promise<void> {
  await db.run('DELETE FROM push_devices WHERE token = ? AND NOT (user_id = ? AND device_id = ?)', [
    device.token,
    user,
    device.deviceId
  ])
  await db.run(
    `INSERT INTO push_devices (user_id, device_id, token, hub_ref) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, device_id) DO UPDATE SET token = excluded.token, hub_ref = excluded.hub_ref`,
    [user, device.deviceId, device.token, device.hubRef]
  )
}

export async function unregisterDevice(
  db: SlayzoneDb,
  user: string,
  deviceId: string
): Promise<boolean> {
  const { changes } = await db.run('DELETE FROM push_devices WHERE user_id = ? AND device_id = ?', [
    user,
    deviceId
  ])
  return changes > 0
}

export async function getDevicePrefs(
  db: SlayzoneDb,
  user: string,
  deviceId: string
): Promise<PushPrefs | null> {
  const row = await db.get<{ notify_ready: number; notify_errors: number }>(
    'SELECT notify_ready, notify_errors FROM push_devices WHERE user_id = ? AND device_id = ?',
    [user, deviceId]
  )
  return row ? { ready: row.notify_ready === 1, errors: row.notify_errors === 1 } : null
}

/** Changes only the kinds named; an unknown phone changes nothing. */
export async function setDevicePrefs(
  db: SlayzoneDb,
  user: string,
  deviceId: string,
  prefs: Partial<PushPrefs>
): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = []
  if (prefs.ready !== undefined) {
    sets.push('notify_ready = ?')
    values.push(prefs.ready ? 1 : 0)
  }
  if (prefs.errors !== undefined) {
    sets.push('notify_errors = ?')
    values.push(prefs.errors ? 1 : 0)
  }
  if (sets.length === 0) return false
  const { changes } = await db.run(
    `UPDATE push_devices SET ${sets.join(', ')} WHERE user_id = ? AND device_id = ?`,
    [...values, user, deviceId]
  )
  return changes > 0
}

/** The phones of these users that want this kind. */
export async function pushRecipients(
  db: SlayzoneDb,
  users: readonly string[],
  kind: PushKind
): Promise<PushRecipient[]> {
  if (users.length === 0) return []
  const column = kind === 'error' ? 'notify_errors' : 'notify_ready'
  return db.all<PushRecipient>(
    `SELECT token, hub_ref AS hubRef FROM push_devices
      WHERE user_id IN (${users.map(() => '?').join(', ')}) AND ${column} = 1
      ORDER BY created_at, rowid`,
    [...users]
  )
}

/** The push service says this token reaches no phone any more. */
export async function forgetToken(db: SlayzoneDb, token: string): Promise<void> {
  await db.run('DELETE FROM push_devices WHERE token = ?', [token])
}

export async function markDelivered(db: SlayzoneDb, tokens: readonly string[]): Promise<void> {
  if (tokens.length === 0) return
  await db.run(
    `UPDATE push_devices SET last_ok_at = datetime('now')
      WHERE token IN (${tokens.map(() => '?').join(', ')})`,
    [...tokens]
  )
}

/**
 * Login was turned on: the phones registered without it (user '') go to the first
 * admin, like the rest of the hub's pre-login data (hub `ownership-backfill.ts`).
 * A phone that admin already registered keeps its own row.
 */
export async function adoptLegacyPushDevices(db: SlayzoneDb, owner: string): Promise<number> {
  await db.run(
    `DELETE FROM push_devices WHERE user_id = ''
       AND device_id IN (SELECT device_id FROM push_devices WHERE user_id = ?)`,
    [owner]
  )
  const { changes } = await db.run(`UPDATE push_devices SET user_id = ? WHERE user_id = ''`, [
    owner
  ])
  return changes
}
