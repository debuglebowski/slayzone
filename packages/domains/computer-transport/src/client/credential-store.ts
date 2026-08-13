/**
 * Computer credential persistence. After enrollment the computer holds a
 * hub-scoped {computerId, apiKey} pair; every hub a computer has joined is kept
 * as one entry in a single 0600 map file at `<ROOT>/computer.state.json`
 * (`{ [hubHost]: StoredComputerCredentials }`), so reconnects (`hello`) survive
 * restarts without re-consuming a join token, and enrolling with a second hub
 * never touches the first hub's entry.
 *
 * @module computer/client/credential-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * The SlayZone root dir for the default credential store. Mirrors platform's
 * getSlayzoneHomeDir precedence (`SLAYZONE_ROOT` > `$HOME/.slayzone`) — inlined
 * here so computer-transport stays free of the @slayzone/platform dep (keeps the
 * computer bundle lean). The standalone computer entrypoint seeds `SLAYZONE_ROOT=cwd`,
 * so this honors the ROOT anchor; without it, the raw home fallback applied and
 * creds landed at `~/.slayzone/computer.state.json`.
 */
function slayzoneRootDir(): string {
  if (process.env.SLAYZONE_ROOT) return process.env.SLAYZONE_ROOT
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
  return join(home, '.slayzone')
}

export const storedComputerCredentialsSchema = z.object({
  computerId: z.string().min(1),
  apiKey: z.string().min(1),
  /** Pin recorded at enroll time (lowercase hex sha256 of the hub leaf DER). */
  pinnedFingerprint: z.string().optional()
})
export type StoredComputerCredentials = z.infer<typeof storedComputerCredentialsSchema>

const credentialsMapSchema = z.record(z.string(), storedComputerCredentialsSchema)
type CredentialsMap = z.infer<typeof credentialsMapSchema>

export interface ComputerCredentialStore {
  /** Null when absent or unreadable/corrupt (treated as not-yet-enrolled). */
  load(): Promise<StoredComputerCredentials | null>
  save(credentials: StoredComputerCredentials): Promise<void>
  clear(): Promise<void>
  /** Absolute path of the backing file (diagnostics). */
  readonly filePath: string
}

/** `wss://hub.example:8443/computers` → `hub.example_8443` (map key). */
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
  return join(baseDir ?? slayzoneRootDir(), 'computer.state.json')
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
    const entry = storedComputerCredentialsSchema.safeParse(value)
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
): ComputerCredentialStore {
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
  initial: StoredComputerCredentials | null = null
): ComputerCredentialStore {
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
