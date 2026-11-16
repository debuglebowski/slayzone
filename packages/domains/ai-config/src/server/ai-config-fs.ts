/**
 * The filesystem the AI-config ops read and write: a project's provider files
 * (`CLAUDE.md`, `.claude/skills/…`, `.mcp.json`) and the computer-level ones under
 * the home dir (`~/.claude/…`). One async seam so the same ops can run against the
 * hub's own disk ({@link localAiConfigFs}) or a computer's.
 *
 * Lean on purpose — node fs + os only, no DB or Electron — so a computer can run it.
 */
import { promises as fsp } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

export interface AiConfigStat {
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
  size: number
}

export interface AiConfigDirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

export const AI_CONFIG_HASH_CAPABILITY = 'agentConfig.hashFiles'
export interface AiConfigFileHash {
  path: string
  hash: string | null
}

// Only in-flight work is shared: an edit after a completed scan is always read.
// The computer checks every caller's path scope before reaching this pure disk work.
const pendingHashes = new Map<string, Promise<string | null>>()
async function hashFile(path: string): Promise<string | null> {
  const pending = pendingHashes.get(path)
  if (pending) return pending
  const work = (async () => {
    if (
      !(await fsp.access(path).then(
        () => true,
        () => false
      ))
    )
      return null
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  })().finally(() => pendingHashes.delete(path))
  pendingHashes.set(path, work)
  return work
}

export async function hashAiConfigFiles(paths: readonly string[]): Promise<AiConfigFileHash[]> {
  const out: AiConfigFileHash[] = []
  // Stream one file at a time: a batch cannot buffer hundreds of large files.
  for (const path of paths) out.push({ path, hash: await hashFile(path) })
  return out
}

export interface AiConfigFs {
  /** Optional on older computers. Digests only; no file contents cross the link. */
  hashFiles?(paths: readonly string[]): Promise<AiConfigFileHash[]>
  /** Whether `path` exists (following symlinks); false on any error, like `existsSync`. */
  exists(path: string): Promise<boolean>
  /** UTF-8 contents; throws when missing or unreadable. */
  readFile(path: string): Promise<string>
  /** UTF-8 write (creates or replaces); the parent must exist. */
  writeFile(path: string, content: string): Promise<void>
  /** `mkdir -p`. */
  mkdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  /** Removes an EMPTY directory; throws otherwise. */
  rmdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Null when `path` does not exist (or cannot be stat'd). */
  stat(path: string): Promise<AiConfigStat | null>
  /** Directory entries; throws when `path` is missing or not a directory. */
  readdir(path: string): Promise<AiConfigDirEntry[]>
  /** The home dir the computer-level provider files live under. */
  homedir(): string
}

/** This machine's disk. */
export const localAiConfigFs: AiConfigFs = {
  hashFiles: hashAiConfigFiles,
  exists: (p) =>
    fsp.access(p).then(
      () => true,
      () => false
    ),
  readFile: (p) => fsp.readFile(p, 'utf-8'),
  writeFile: (p, content) => fsp.writeFile(p, content, 'utf-8'),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true })
  },
  unlink: (p) => fsp.unlink(p),
  rmdir: (p) => fsp.rmdir(p),
  rename: (from, to) => fsp.rename(from, to),
  stat: async (p) => {
    try {
      const s = await fsp.stat(p)
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  },
  readdir: async (p) =>
    (await fsp.readdir(p, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory()
    })),
  homedir: () => homedir()
}
