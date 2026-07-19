/**
 * Runner credential persistence. After enrollment the runner holds a
 * hub-scoped {runnerId, apiKey} pair; it lives in a 0600 file at
 * `<ROOT>/runners/<hub-host>.json` so reconnects (`hello`) survive restarts
 * without re-consuming a join token.
 *
 * @module runner/client/credential-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * The SlayZone root dir for the default credential store. Mirrors platform's
 * getSlayzoneHomeDir precedence (`SLAYZONE_ROOT` > `SLAYZONE_HOME_DIR` >
 * `$HOME/.slayzone`) — inlined here so runner-transport stays free of the
 * @slayzone/platform dep (keeps the runner bundle lean). The standalone runner
 * entrypoint seeds `SLAYZONE_ROOT=cwd`, so this honors the ROOT anchor; without
 * it, the raw home fallback applied and creds landed at `~/.slayzone/runners`.
 */
function slayzoneRootDir(): string {
  if (process.env.SLAYZONE_ROOT) return process.env.SLAYZONE_ROOT
  if (process.env.SLAYZONE_HOME_DIR) return process.env.SLAYZONE_HOME_DIR
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
  return join(home, '.slayzone')
}

export const storedRunnerCredentialsSchema = z.object({
  runnerId: z.string().min(1),
  apiKey: z.string().min(1),
  /** Pin recorded at enroll time (lowercase hex sha256 of the hub leaf DER). */
  pinnedFingerprint: z.string().optional()
})
export type StoredRunnerCredentials = z.infer<typeof storedRunnerCredentialsSchema>

export interface RunnerCredentialStore {
  /** Null when absent or unreadable/corrupt (treated as not-yet-enrolled). */
  load(): Promise<StoredRunnerCredentials | null>
  save(credentials: StoredRunnerCredentials): Promise<void>
  clear(): Promise<void>
  /** Absolute path of the backing file (diagnostics). */
  readonly filePath: string
}

/** `wss://hub.example:8443/runners` → `hub.example_8443` (filename-safe). */
export function hubHostFromUrl(url: string): string {
  const parsed = new URL(url)
  return parsed.port ? `${parsed.hostname}_${parsed.port}` : parsed.hostname
}

function sanitizeHubHost(hubHost: string): string {
  const sanitized = hubHost.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!sanitized || /^\.+$/.test(sanitized)) {
    throw new Error(`invalid hub host for credential file: '${hubHost}'`)
  }
  return sanitized
}

export function credentialFilePathFor(hubHost: string, baseDir?: string): string {
  const dir = baseDir ?? join(slayzoneRootDir(), 'runners')
  return join(dir, `${sanitizeHubHost(hubHost)}.json`)
}

export function createFileCredentialStore(
  hubHost: string,
  options: { baseDir?: string } = {}
): RunnerCredentialStore {
  const filePath = credentialFilePathFor(hubHost, options.baseDir)

  return {
    filePath,
    async load() {
      let raw: string
      try {
        raw = await readFile(filePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      try {
        const parsed = storedRunnerCredentialsSchema.safeParse(JSON.parse(raw))
        return parsed.success ? parsed.data : null
      } catch {
        return null
      }
    },
    async save(credentials) {
      const dir = dirname(filePath)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      // Atomic replace: write a 0600 sibling, then rename over the target so a
      // crash never leaves a partially written credential file.
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
      try {
        await rename(tmpPath, filePath)
      } catch (err) {
        await rm(tmpPath, { force: true })
        throw err
      }
    },
    async clear() {
      await rm(filePath, { force: true })
    }
  }
}

/** In-memory store for tests and embedded use. */
export function createMemoryCredentialStore(
  initial: StoredRunnerCredentials | null = null
): RunnerCredentialStore {
  let credentials = initial
  return {
    filePath: '<memory>',
    load: async () => credentials,
    save: async (next) => {
      credentials = next
    },
    clear: async () => {
      credentials = null
    }
  }
}
