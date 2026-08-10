/**
 * The workspace filesystem seam.
 *
 * Every filesystem op the UI performs against a *workspace* — browsing for a
 * project directory, reading the editor tree, writing a file, watching for
 * changes — must execute on the machine that owns that workspace. With the
 * hub/runner split that machine is a runner, which may be a different host
 * entirely. Running these on the hub is how a task on a remote runner reported
 * "No repository path configured" for a path that existed perfectly well: the
 * hub was answering about its own disk.
 *
 * This module defines the two halves of the seam:
 *
 *  - {@link LocalWorkspaceFs} — the in-process implementation, i.e. the existing
 *    `file-ops`/`watcher` functions plus the three browse ops, bound to THIS
 *    process's disk.
 *  - {@link WorkspaceFsAdapters} — the same surface with a leading
 *    `runnerId: string | null`. `createRemoteFsAdapters` (runner-transport)
 *    implements it by forwarding to the runner's `fs.*` frames.
 *
 * The interface lives here rather than in runner-transport because
 * `@slayzone/transport` is deliberately decoupled from runner-transport (see the
 * `RunnerGateway` note in transport's app-deps) and both sides already depend on
 * this package. Keeping ONE declaration is the point: a structurally mirrored
 * copy is precisely the drift that cost four wire-contract fixes in the runner
 * frames.
 *
 * **On `runnerId: null`.** It means "no runner exists to ask", not "prefer the
 * hub". Resolution goes through the same `resolveExecRunner` the pty backend
 * uses, so whenever any runner is connected it is chosen; null is reached only
 * on a hub with zero runners — the standalone/fork sidecar, or before the local
 * runner has enrolled. There the hub's disk is the only disk there is, and
 * refusing would break the editor and the picker for no safety gain. This is
 * consistent with docs/exec-boundary.md, whose zero-runner acceptance test
 * requires the UI to keep rendering and reserves hard failure for spawning
 * agents and mutating worktrees.
 *
 * @module file-editor/server/workspace-fs
 */

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import {
  copy,
  copyIn,
  createDir,
  createFile,
  deletePath,
  gitStatus,
  listAllFiles,
  readDir,
  readFile,
  renamePath,
  searchFiles,
  writeFile
} from './file-ops'
import { subscribeFileWatcher, type FileWatchEvent } from './watcher'
import { discoverRepos, type DiscoveredRepo } from './repo-discovery'
import type {
  DirEntry,
  FileSearchResult,
  GitStatusMap,
  ReadFileResult,
  SearchFilesOptions
} from '../shared'

/** Where a picker may start browsing, described in the target machine's idiom. */
export interface WorkspaceRoots {
  /** Browsable roots. On a runner these are its `allowedRoots` path-jail. */
  roots: string[]
  /** The target user's home directory, for a sensible default expansion. */
  home: string | null
  /** `process.platform` of the target, so the client renders paths correctly. */
  platform: string
  /** Path separator of the target — never assume POSIX. */
  sep: string
}

export interface BrowseEntry {
  name: string
  /** ABSOLUTE path on the target machine. */
  path: string
  type: 'directory' | 'file'
  isSymlink?: boolean
  /** Directory contains `.git` — lets a picker mark repositories. */
  isGitRepo?: boolean
}

export interface BrowseResult {
  /** The realpath-resolved directory actually listed. */
  path: string
  /** Parent directory, or null when there is nothing browsable above. */
  parent: string | null
  entries: BrowseEntry[]
}

export interface BrowseOptions {
  dirsOnly?: boolean
  includeHidden?: boolean
}

/** Whole-tree reads carry a `truncated` flag so a capped result never reads as complete. */
export interface ListAllFilesResult {
  files: string[]
  truncated: boolean
}

export interface SearchResult {
  results: FileSearchResult[]
  truncated: boolean
}

/**
 * The in-process half of the seam — operations on THIS machine's disk.
 *
 * Split into browse ops (absolute paths, no root) and editor ops (root-scoped,
 * gitignore-aware) because they answer different questions: the picker must
 * describe a machine before a project exists; the editor works inside one.
 */
/** Where a runner keeps one project, and whether that path is still there. */
export interface ProjectLocation {
  /** Null = this runner has no checkout of that project. A real state. */
  path: string | null
  source?: 'adopted' | 'provisioned'
  /** False when the recorded path has since vanished from disk. */
  exists?: boolean
}

/** Outcome of editing a runner's path-jail — see `setAllowedRoots`. */
export interface SetRootsResult {
  /** The set actually applied, canonicalized and de-duplicated. */
  roots: string[]
  /** Requested roots that did not take, and why. */
  rejected: { path: string; reason: string }[]
}

export interface LocalWorkspaceFs {
  listRoots(): WorkspaceRoots
  listDir(path: string, options?: BrowseOptions): Promise<BrowseResult>
  mkdir(path: string): Promise<{ path: string }>
  pathExists(path: string): boolean
  setAllowedRoots(roots: string[]): Promise<SetRootsResult>
  discoverRepos(rootPath: string, maxDepth?: number): Promise<DiscoveredRepo[]>
  resolveProjectPath(projectId: string): ProjectLocation
  setProjectPath(
    projectId: string,
    path: string,
    source: 'adopted' | 'provisioned'
  ): { path: string }
  forgetProjectPath(projectId: string): void
  ensureProjectCheckout(projectId: string): {
    path: string | null
    outcome: 'present' | 'cloned' | 'missing' | 'unavailable'
  }
  gitReadiness(): {
    gitInstalled: boolean
    ghInstalled: boolean
    ghAuthenticated: boolean
    repoReachable?: boolean
    detail?: string
  }

  readDir(rootPath: string, dirPath: string): DirEntry[]
  readFile(rootPath: string, filePath: string, force?: boolean): ReadFileResult
  writeFile(rootPath: string, filePath: string, content: string): void
  createFile(rootPath: string, filePath: string): void
  createDir(rootPath: string, dirPath: string): void
  rename(rootPath: string, oldPath: string, newPath: string): void
  delete(rootPath: string, targetPath: string): void
  copyIn(rootPath: string, absoluteSrc: string, targetDir?: string): string
  copy(rootPath: string, srcPath: string, destPath: string): void
  gitStatus(rootPath: string): Promise<GitStatusMap>
  searchFiles(rootPath: string, query: string, options?: SearchFilesOptions): SearchResult
  listAllFiles(rootPath: string): ListAllFilesResult
  watch(rootPath: string, listener: (e: FileWatchEvent) => void): () => void
}

/**
 * The routed seam. Same surface, addressed by runner.
 *
 * `runnerId: null` = execute in-process (see the module note on why that is a
 * boundary condition and not a fallback).
 */
export interface WorkspaceFsAdapters {
  listRoots(runnerId: string | null): Promise<WorkspaceRoots>
  listDir(runnerId: string | null, path: string, options?: BrowseOptions): Promise<BrowseResult>
  mkdir(runnerId: string | null, path: string): Promise<{ path: string }>
  pathExists(runnerId: string | null, path: string): Promise<boolean>
  /**
   * Replace a runner's path-jail. Only meaningful for a real runner — a hub has
   * no jail, so `runnerId: null` rejects rather than pretending to save.
   */
  setAllowedRoots(runnerId: string | null, roots: string[]): Promise<SetRootsResult>

  /**
   * Where does this runner keep that project?
   *
   * The hub does not know and must not guess — it held one `projects.path`
   * column, which could only ever be right about one machine. Ask the runner.
   */
  resolveProjectPath(runnerId: string | null, projectId: string): Promise<ProjectLocation>
  /** Record where a project lives on that runner (adopt, or after a clone). */
  setProjectPath(
    runnerId: string | null,
    projectId: string,
    path: string,
    source: 'adopted' | 'provisioned'
  ): Promise<{ path: string }>
  /** Drop the mapping. Never touches the checkout itself. */
  forgetProjectPath(runnerId: string | null, projectId: string): Promise<void>
  /**
   * Make a project usable on that runner before an agent starts — cloning it
   * when `repoUrl` is given (remote-git mode). Without a URL a missing checkout
   * is reported, never recreated: the folder was one the user chose.
   */
  ensureProjectCheckout(
    runnerId: string | null,
    input: {
      projectId: string
      checkoutId: string
      repoUrl?: string
      branch?: string
      workspaceRoot?: string
    }
  ): Promise<{
    path: string | null
    outcome: 'present' | 'cloned' | 'missing' | 'unavailable'
    error?: string
  }>
  /**
   * Can that machine do git work with the credentials it already has?
   *
   * SlayZone stores no git secrets — agents already push from the runner using
   * its own `gh auth` / ssh-agent. This makes that prerequisite visible instead
   * of taking custody of it.
   */
  gitReadiness(
    runnerId: string | null,
    repoUrl?: string
  ): Promise<{
    gitInstalled: boolean
    ghInstalled: boolean
    ghAuthenticated: boolean
    repoReachable?: boolean
    detail?: string
  }>

  /**
   * Every git repo under `rootPath`, discovered ON the target machine.
   *
   * One call, not one per directory: a depth-3 walk routed directory-by-directory
   * would be dozens of round-trips for a result the runner can compute locally.
   */
  discoverRepos(
    runnerId: string | null,
    rootPath: string,
    maxDepth?: number
  ): Promise<DiscoveredRepo[]>

  readDir(runnerId: string | null, rootPath: string, dirPath: string): Promise<DirEntry[]>
  readFile(
    runnerId: string | null,
    rootPath: string,
    filePath: string,
    force?: boolean
  ): Promise<ReadFileResult>
  writeFile(
    runnerId: string | null,
    rootPath: string,
    filePath: string,
    content: string
  ): Promise<void>
  createFile(runnerId: string | null, rootPath: string, filePath: string): Promise<void>
  createDir(runnerId: string | null, rootPath: string, dirPath: string): Promise<void>
  rename(runnerId: string | null, rootPath: string, oldPath: string, newPath: string): Promise<void>
  delete(runnerId: string | null, rootPath: string, targetPath: string): Promise<void>
  copyIn(
    runnerId: string | null,
    rootPath: string,
    absoluteSrc: string,
    targetDir?: string
  ): Promise<string>
  copy(runnerId: string | null, rootPath: string, srcPath: string, destPath: string): Promise<void>
  gitStatus(runnerId: string | null, rootPath: string): Promise<GitStatusMap>
  searchFiles(
    runnerId: string | null,
    rootPath: string,
    query: string,
    options?: SearchFilesOptions
  ): Promise<SearchResult>
  listAllFiles(runnerId: string | null, rootPath: string): Promise<ListAllFilesResult>
  /**
   * Subscribe to changes under `rootPath`. Returns a disposer.
   *
   * Synchronous return even though a routed start is a round-trip: callers are
   * tRPC `observable()` bodies, which must hand back a teardown immediately. The
   * routed implementation starts in the background and the disposer cancels
   * whatever state that start reached.
   */
  watch(
    runnerId: string | null,
    rootPath: string,
    listener: (e: FileWatchEvent) => void
  ): () => void
}

/** Never listed by the browse ops — noise in a picker, and `.git` is never a target. */
const BROWSE_ALWAYS_HIDDEN = new Set(['.git', '.DS_Store', 'node_modules'])

/** Transport caps, mirrored here so local and routed truncate identically. */
export const WORKSPACE_MAX_LIST_ALL_FILES = 50_000
export const WORKSPACE_MAX_SEARCH_RESULTS = 2_000

/**
 * Build the in-process implementation.
 *
 * Browse ops are unjailed here on purpose: a hub has no `allowedRoots` (that is
 * a runner concept), so the only honest answer to "what may I browse" is the
 * whole filesystem, seeded at `$HOME`.
 */
export function createLocalWorkspaceFs(): LocalWorkspaceFs {
  const localProjectPaths = new Map<string, string>()
  return {
    listRoots() {
      let home: string | null = null
      try {
        home = realpathSync.native(homedir())
      } catch {
        home = null
      }
      return {
        roots: home ? [home] : [parse(process.cwd()).root],
        home,
        platform: process.platform,
        sep
      }
    },

    async listDir(path, options) {
      const abs = realpathSync.native(resolve(path))
      const dirents = await readdir(abs, { withFileTypes: true })
      const entries: BrowseEntry[] = []
      for (const e of dirents) {
        if (BROWSE_ALWAYS_HIDDEN.has(e.name)) continue
        if (!options?.includeHidden && e.name.startsWith('.')) continue

        const full = join(abs, e.name)
        const symlink = e.isSymbolicLink()
        let isDir = e.isDirectory()
        if (symlink) {
          // The dirent describes the link, not its target. A broken link stats
          // nothing and is skipped rather than shown as an unopenable entry.
          try {
            isDir = (await stat(full)).isDirectory()
          } catch {
            continue
          }
        }
        if (options?.dirsOnly && !isDir) continue

        entries.push({
          name: e.name,
          path: full,
          type: isDir ? 'directory' : 'file',
          ...(symlink && { isSymlink: true }),
          ...(isDir && existsSync(join(full, '.git')) && { isGitRepo: true })
        })
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const parent = dirname(abs)
      return { path: abs, parent: parent === abs ? null : parent, entries }
    },

    async mkdir(path) {
      const abs = resolve(path)
      await mkdir(abs, { recursive: true })
      return { path: realpathSync.native(abs) }
    },

    pathExists(path) {
      return existsSync(resolve(path))
    },

    // A hub has no path-jail — `allowedRoots` is a runner concept. Saying so is
    // better than accepting the edit and discarding it, which would leave the
    // user believing they had restricted (or widened) something.
    setAllowedRoots() {
      return Promise.reject(
        new Error('this host has no path jail to configure — allowedRoots is a runner setting')
      )
    },

    // With no runner there is exactly one machine, so this process keeps the map
    // itself. In-memory rather than on disk: the only hosts that reach here are
    // the fork sidecar and tests, neither of which should be minting a new
    // persistent state file for a mapping a real runner owns.
    resolveProjectPath(projectId) {
      const path = localProjectPaths.get(projectId)
      if (!path) return { path: null }
      return { path, source: 'adopted' as const, exists: existsSync(path) }
    },
    setProjectPath(projectId, path) {
      const abs = realpathSync.native(resolve(path))
      localProjectPaths.set(projectId, abs)
      return { path: abs }
    },
    forgetProjectPath(projectId) {
      localProjectPaths.delete(projectId)
    },
    // No runner means no provisioning story: this host has no workspace root and
    // no clone lifecycle. Report what is there and stop, rather than inventing a
    // checkout in a process that only exists for the fork sidecar and tests.
    ensureProjectCheckout(projectId) {
      const path = localProjectPaths.get(projectId)
      if (!path) return { path: null, outcome: 'unavailable' as const }
      return existsSync(path)
        ? { path, outcome: 'present' as const }
        : { path, outcome: 'missing' as const }
    },

    readDir,
    readFile,
    writeFile,
    createFile,
    createDir,
    rename: renamePath,
    delete: deletePath,
    copyIn,
    copy,
    gitStatus,

    searchFiles(rootPath, query, options) {
      const maxResults = Math.min(
        options?.maxResults ?? WORKSPACE_MAX_SEARCH_RESULTS,
        WORKSPACE_MAX_SEARCH_RESULTS
      )
      const results = searchFiles(rootPath, query, { ...options, maxResults })
      const total = results.reduce((n, r) => n + r.matches.length, 0)
      return { results, truncated: total >= maxResults }
    },

    listAllFiles(rootPath) {
      const all = listAllFiles(rootPath)
      return {
        files: all.slice(0, WORKSPACE_MAX_LIST_ALL_FILES),
        truncated: all.length > WORKSPACE_MAX_LIST_ALL_FILES
      }
    },

    watch: subscribeFileWatcher,
    // Nothing here provisions a checkout, so there is no credential story to
    // report on. Claiming readiness would be a guess about a machine that never
    // clones anything.
    gitReadiness: () => ({
      gitInstalled: false,
      ghInstalled: false,
      ghAuthenticated: false,
      detail: 'this host does not provision checkouts'
    }),
    discoverRepos
  }
}

/**
 * Adapters that always execute in-process, whatever `runnerId` says.
 *
 * For hosts with no runner gateway at all — the standalone/fork sidecar and
 * tests. A hub that HAS a gateway installs `createRemoteFsAdapters` instead,
 * which falls through to a `LocalWorkspaceFs` only on `runnerId: null`.
 */
export function createLocalWorkspaceFsAdapters(
  local: LocalWorkspaceFs = createLocalWorkspaceFs()
): WorkspaceFsAdapters {
  return {
    listRoots: async () => local.listRoots(),
    listDir: async (_r, path, options) => local.listDir(path, options),
    mkdir: async (_r, path) => local.mkdir(path),
    pathExists: async (_r, path) => local.pathExists(path),
    setAllowedRoots: async (_r, roots) => local.setAllowedRoots(roots),
    resolveProjectPath: async (_r, projectId) => local.resolveProjectPath(projectId),
    setProjectPath: async (_r, projectId, path, source) =>
      local.setProjectPath(projectId, path, source),
    forgetProjectPath: async (_r, projectId) => local.forgetProjectPath(projectId),
    ensureProjectCheckout: async (_r, input) => local.ensureProjectCheckout(input.projectId),
    // No runner: nothing here has a credential story to report on, and claiming
    // readiness for a host that never clones would be a guess.
    gitReadiness: async () => ({
      gitInstalled: false,
      ghInstalled: false,
      ghAuthenticated: false,
      detail: 'no runner to probe — this host does not provision checkouts'
    }),

    readDir: async (_r, rootPath, dirPath) => local.readDir(rootPath, dirPath),
    readFile: async (_r, rootPath, filePath, force) => local.readFile(rootPath, filePath, force),
    writeFile: async (_r, rootPath, filePath, content) =>
      local.writeFile(rootPath, filePath, content),
    createFile: async (_r, rootPath, filePath) => local.createFile(rootPath, filePath),
    createDir: async (_r, rootPath, dirPath) => local.createDir(rootPath, dirPath),
    rename: async (_r, rootPath, oldPath, newPath) => local.rename(rootPath, oldPath, newPath),
    delete: async (_r, rootPath, targetPath) => local.delete(rootPath, targetPath),
    copyIn: async (_r, rootPath, absoluteSrc, targetDir) =>
      local.copyIn(rootPath, absoluteSrc, targetDir),
    copy: async (_r, rootPath, srcPath, destPath) => local.copy(rootPath, srcPath, destPath),
    gitStatus: async (_r, rootPath) => local.gitStatus(rootPath),
    searchFiles: async (_r, rootPath, query, options) =>
      local.searchFiles(rootPath, query, options),
    listAllFiles: async (_r, rootPath) => local.listAllFiles(rootPath),
    watch: (_r, rootPath, listener) => local.watch(rootPath, listener),
    discoverRepos: async (_r, rootPath, maxDepth) => local.discoverRepos(rootPath, maxDepth)
  }
}
