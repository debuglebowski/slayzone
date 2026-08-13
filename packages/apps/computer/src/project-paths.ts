/**
 * Where THIS computer keeps each project on its own disk.
 *
 * The hub used to hold one `projects.path` column: a directory it cannot see, on
 * a machine it does not own, with no room for a second answer. Two computers laying
 * the same project out differently made the hub necessarily wrong about one of
 * them, and a Windows computer does not even agree on the separator. So the mapping
 * moved here, where the disk is.
 *
 * Persisted at `<ROOT>/computer.projects.json`, keyed by hub host then project id —
 * the same two-level shape as `computer.state.json`, and for the same reason: a
 * computer can be enrolled with several hubs, and dropping one hub's entry must not
 * disturb another's.
 *
 * Not a secret, but written 0600 through the same atomic replace anyway: a
 * half-written map would strand every project on this machine, which is a worse
 * failure than a slightly over-tight mode bit.
 *
 * @module computer/project-paths
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** Mirrors the credential store's precedence: `SLAYZONE_ROOT` > `$HOME/.slayzone`. */
function slayzoneRootDir(): string {
  if (process.env.SLAYZONE_ROOT) return process.env.SLAYZONE_ROOT
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
  return join(home, '.slayzone')
}

export const projectPathEntrySchema = z.object({
  /** Absolute, realpath-resolved at write time. */
  path: z.string().min(1),
  updatedAt: z.number()
})
export type ProjectPathEntry = z.infer<typeof projectPathEntrySchema>

const projectMapSchema = z.record(z.string(), projectPathEntrySchema)
type ProjectMap = z.infer<typeof projectMapSchema>

export interface ProjectPathStore {
  /** Null when this computer has no checkout of that project — a real state. */
  get(projectId: string): ProjectPathEntry | null
  set(projectId: string, path: string): Promise<ProjectPathEntry>
  forget(projectId: string): Promise<void>
  list(): Array<{ projectId: string } & ProjectPathEntry>
  /** Absolute path of the backing file (diagnostics). */
  readonly filePath: string
}

export function projectsFilePath(baseDir?: string): string {
  return join(baseDir ?? slayzoneRootDir(), 'computer.projects.json')
}

/** Whole file: `{ [hubHost]: { [projectId]: entry } }`. */
const fileSchema = z.record(z.string(), projectMapSchema)

async function readFileMap(filePath: string): Promise<Record<string, ProjectMap>> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  // Drop only the entries that fail validation, never the whole file — one bad
  // row must not orphan every other project on this machine.
  const out: Record<string, ProjectMap> = {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  for (const [host, projects] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof projects !== 'object' || projects === null) continue
    const map: ProjectMap = {}
    for (const [projectId, entry] of Object.entries(projects as Record<string, unknown>)) {
      const ok = projectPathEntrySchema.safeParse(entry)
      if (ok.success) map[projectId] = ok.data
    }
    out[host] = map
  }
  return fileSchema.parse(out)
}

async function writeFileMap(filePath: string, map: Record<string, ProjectMap>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmpPath, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
  try {
    await rename(tmpPath, filePath)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

/**
 * Load the store for one hub.
 *
 * Reads once at construction and serves `get` from memory: resolving a cwd sits
 * directly in the agent-spawn path, and a disk read per spawn would put file I/O
 * between the user pressing start and the pty existing. Writes are write-through,
 * and re-read the whole file first so a concurrent computer for a DIFFERENT hub
 * cannot be clobbered by this one's write.
 */
export async function createProjectPathStore(
  hubHost: string,
  options: { baseDir?: string } = {}
): Promise<ProjectPathStore> {
  if (!hubHost.trim()) throw new Error(`invalid hub host for project map: '${hubHost}'`)
  const filePath = projectsFilePath(options.baseDir)
  let cache: ProjectMap = (await readFileMap(filePath))[hubHost] ?? {}

  return {
    filePath,

    get(projectId) {
      return cache[projectId] ?? null
    },

    async set(projectId, path) {
      const entry: ProjectPathEntry = { path, updatedAt: Date.now() }
      const all = await readFileMap(filePath)
      all[hubHost] = { ...(all[hubHost] ?? {}), [projectId]: entry }
      await writeFileMap(filePath, all)
      cache = all[hubHost]
      return entry
    },

    async forget(projectId) {
      const all = await readFileMap(filePath)
      const forHub = { ...(all[hubHost] ?? {}) }
      delete forHub[projectId]
      all[hubHost] = forHub
      await writeFileMap(filePath, all)
      cache = forHub
    },

    list() {
      return Object.entries(cache).map(([projectId, entry]) => ({ projectId, ...entry }))
    }
  }
}
