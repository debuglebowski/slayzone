/**
 * Which settings belong to one user and which to the hub (T-16).
 *
 * The `settings` table was one global key/value store, which is right for a hub
 * with one operator and wrong for a hub with several users: one user's open tabs
 * (`viewState`) decided which of ANOTHER user's temporary tasks the boot purge
 * deleted, and every user saw every other user's layout, filters and project-keyed
 * state. On a request that carries a user (a hub that requires login), keys are
 * routed by scope:
 *
 *   - `hub`: read by the hub's own server code to decide what it does — task
 *     creation defaults, worktree behaviour, the idle-close sweep, the warm pool,
 *     diagnostics, ports, backups. That code has no user to ask about, so these
 *     stay in `settings`, one value for everyone. A closed list: a key goes here
 *     only when server code reads it (the grep is `FROM settings` / `SettingsService`).
 *   - `internal`: secrets the server keeps in `settings` for itself (integration
 *     credentials). Never served or written through the settings API, to anyone.
 *   - `user`: everything else — what a client stores for its own UI. Per user, in
 *     `user_settings`. The DEFAULT, so a key added later is private until someone
 *     decides otherwise; the failure mode of a misclassified server-read key is a
 *     preference that has no effect on a login hub, never one user seeing another's.
 *
 * A request with no user (a hub without login — the desktop app's) is unaffected:
 * every key except `internal` reads and writes `settings`, exactly as before.
 *
 * A `user` key never falls back to a `settings` row: that row is legacy state of
 * whoever ran the hub before login (the first admin adopts it at boot, see
 * `adoptLegacyUserSettings`), and serving it to every user is the leak this fixes.
 * So a migration that seeds a `user` key's default only seeds it for a hub without
 * login — put a per-user default in the client.
 */
import {
  LOCAL_COMPUTER_WORK_ROOTS_KEY,
  POLICY_LOCK_PREFIX,
  projectOfKeyedSetting,
  settingRule
} from '../shared/registry'

export { LOCAL_COMPUTER_WORK_ROOTS_KEY, POLICY_LOCK_PREFIX }

export type SettingScope = 'hub' | 'user' | 'internal'

/**
 * Keys that describe this one machine, never another: left out of every export and
 * ignored by every import (final review round 3, R3-2). Also `internal`: the settings
 * API neither serves nor writes them. Declared in the registry (`machineLocal`).
 */
export function isMachineLocalSetting(key: string): boolean {
  return settingRule(key)?.machineLocal === true
}

/**
 * Where a key is stored and who may write it, from the registry
 * (`../shared/registry`). Device keys are stored like `user` keys: per user on a hub
 * with login (each device keeps its own copy on top, `deviceSettingsLink`).
 */
export function settingScope(key: string): SettingScope {
  const kind = settingRule(key)?.kind
  if (kind === 'internal') return 'internal'
  if (kind === 'hub') return 'hub'
  return 'user'
}

/** The project a project-keyed hub key (`ai_providers:<projectId>` …) belongs to, or
 *  null for any other key. An export of one user's content (T-101) keeps only theirs. */
export function settingProjectId(key: string): string | null {
  return projectOfKeyedSetting(key)
}
