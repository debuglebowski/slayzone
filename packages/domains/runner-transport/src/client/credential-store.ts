/**
 * Runner credential persistence. After enrollment the runner holds a
 * hub-scoped {runnerId, apiKey} pair; every hub a runner has joined is kept
 * as one entry in a single 0600 map file at `<ROOT>/runner.state.json`
 * (`{ [hubHost]: StoredRunnerCredentials }`), so reconnects (`hello`) survive
 * restarts without re-consuming a join token, and enrolling with a second hub
 * never touches the first hub's entry.
 *
 * @module runner/client/credential-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * The SlayZone root dir for the default credential store. Mirrors platform's
 * getSlayzoneHomeDir precedence (`SLAYZONE_ROOT` > `$HOME/.slayzone`) — inlined
 * here so runner-transport stays free of the @slayzone/platform dep (keeps the
 * runner bundle lean). The standalone runner entrypoint seeds `SLAYZONE_ROOT=cwd`,
 * so this honors the ROOT anchor; without it, the raw home fallback applied and
 * creds landed at `~/.slayzone/runner.state.json`.
 */
function slayzoneRootDir(): string {
  if (process.env.SLAYZONE_ROOT) return process.env.SLAYZONE_ROOT
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

const credentialsMapSchema = z.record(z.string(), storedRunnerCredentialsSchema)
type CredentialsMap = z.infer<typeof credentialsMapSchema>

export interface RunnerCredentialStore {
  /** Null when absent or unreadable/corrupt (treated as not-yet-enrolled). */
  load(): Promise<StoredRunnerCredentials | null>
  save(credentials: StoredRunnerCredentials): Promise<void>
  clear(): Promise<void>
  /** Absolute path of the backing file (diagnostics). */
  readonly filePath: string
}

/** `wss://hub.example:8443/runners` → `hub.example_8443` (map key). */
export function hubHostFromUrl(url: string): string {
  const parsed = new URL(url)
  return parsed.port ? `${parsed.hostname}_${parsed.port}` : parsed.hostname
}

/**
 * Guards against a clearly-wrong key landing in the map. No longer sanitizes
 * for filesystem safety (a JSON object key isn't a path component and can't
 * traverse anything) — only rejects empty/whitespace-only values.
 */
function assertValidHubHost(hubHost: string): void {
  if (!hubHost.trim()) {
    throw new Error(`invalid hub host for credential entry: '${hubHost}'`)
  }
}

export function credentialsFilePath(baseDir?: string): string {
  return join(baseDir ?? slayzoneRootDir(), 'runner.state.json')
}

/** Reads the whole map, tolerating a missing/corrupt file (→ `{}`) and dropping any single entry that fails schema validation rather than discarding every other hub's credentials. */
async function readCredentialsMap(filePath: string): Promise<CredentialsMap> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) return {}
  const map: CredentialsMap = {}
  for (const [key, value] of Object.entries(parsedJson as Record<string, unknown>)) {
    const entry = storedRunnerCredentialsSchema.safeParse(value)
    if (entry.success) map[key] = entry.data
  }
  return map
}

/** Atomic replace of the whole map: write a 0600 sibling, then rename over the target so a crash never leaves a partially written file. */
async function writeCredentialsMap(filePath: string, map: CredentialsMap): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmpPath, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
  try {
    await rename(tmpPath, filePath)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

export function createFileCredentialStore(
  hubHost: string,
  options: { baseDir?: string } = {}
): RunnerCredentialStore {
  assertValidHubHost(hubHost)
  const filePath = credentialsFilePath(options.baseDir)

  return {
    filePath,
    async load() {
      const map = await readCredentialsMap(filePath)
      return map[hubHost] ?? null
    },
    async save(credentials) {
      const map = await readCredentialsMap(filePath)
      map[hubHost] = credentials
      await writeCredentialsMap(filePath, map)
    },
    async clear() {
      const map = await readCredentialsMap(filePath)
      if (!(hubHost in map)) return
      delete map[hubHost]
      if (Object.keys(map).length === 0) {
        await rm(filePath, { force: true })
      } else {
        await writeCredentialsMap(filePath, map)
      }
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
