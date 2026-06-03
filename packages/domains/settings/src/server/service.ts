import type { SlayzoneDb } from '@slayzone/platform'

export type ThemePreference = 'light' | 'dark' | 'system'

export class SettingsService {
  // One shared instance per DB handle. The warmed cache is per-instance and
  // write-through only fires for keys warmed on THAT instance, so a second
  // instance would fork a private cache that silently diverges from sync
  // getCached() readers (e.g. the idle-close sweep). Private constructor +
  // forDatabase() make that fork impossible to write by accident.
  private static readonly instances = new WeakMap<SlayzoneDb, SettingsService>()

  private readonly cache = new Map<string, string | undefined>()
  private readonly cached = new Set<string>()

  private constructor(private readonly db: SlayzoneDb) {}

  static forDatabase(db: SlayzoneDb): SettingsService {
    let inst = SettingsService.instances.get(db)
    if (!inst) {
      inst = new SettingsService(db)
      SettingsService.instances.set(db, inst)
    }
    return inst
  }

  async get(key: string): Promise<string | undefined> {
    const row = (await this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)) as
      | { value: string }
      | undefined
    return row?.value
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value)
    if (this.cached.has(key)) this.cache.set(key, value)
  }

  async getAll(): Promise<Record<string, string>> {
    const rows = (await this.db.prepare('SELECT key, value FROM settings').all()) as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  async getJSON<T>(key: string): Promise<T | undefined> {
    const raw = await this.get(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value))
  }

  async getTheme(): Promise<ThemePreference> {
    const raw = (await this.get('theme')) as ThemePreference | undefined
    return raw ?? 'dark'
  }

  async setTheme(theme: ThemePreference): Promise<void> {
    await this.set('theme', theme)
  }

  async seedOnboardingCompleted(): Promise<void> {
    await this.set('onboarding_completed', 'true')
  }

  async markCliMigrationDialogShown(): Promise<boolean> {
    if (await this.get('cli_migration_dialog_shown')) return false
    await this.set('cli_migration_dialog_shown', '1')
    return true
  }

  async getShortcutOverrides(): Promise<Record<string, string | null>> {
    return (await this.getJSON<Record<string, string | null>>('custom_shortcuts')) ?? {}
  }

  // Sync-IPC support: pre-warm specific keys at boot so renderer's
  // sendSync handlers can read without crossing the async boundary.
  // After B3 (out-of-process server), warmCache fetches via IPC once;
  // getCached stays sync.
  async warmCache(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.cache.set(key, await this.get(key))
      this.cached.add(key)
    }
  }

  getCached(key: string): string | undefined {
    if (!this.cached.has(key)) {
      throw new Error(`SettingsService: key "${key}" not pre-warmed. Call warmCache([...]) first.`)
    }
    return this.cache.get(key)
  }
}
