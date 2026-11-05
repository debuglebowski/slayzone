/**
 * Computer-side filesystem exec handlers.
 *
 * Three groups, matching the `fs.` frame contract:
 *
 *  - **raw probes** (`fs.pathExists`, `fs.removeDir`) — the original routed
 *    seams behind `WorktreeExecAdapters`.
 *  - **workspace browse** (`fs.listRoots`, `fs.listDir`, `fs.mkdir`) — ABSOLUTE
 *    paths inside the path-jail. These back the desktop's directory picker,
 *    which has to describe THIS machine's disk before any project root exists.
 *    A native dialog on the desktop cannot: it browses the desktop's own
 *    filesystem and yields paths that do not exist here.
 *  - **file editor** (`fs.readDir` … `fs.watchStop`) — root-scoped, gitignore
 *    aware. These delegate to `@slayzone/file-editor/server`, the SAME module
 *    the hub used to call in-process. It is pure `node:fs` + `ignore`, so the
 *    computer imports it rather than reimplementing it; hub-local and computer-routed
 *    execution then run identical code and cannot drift in behaviour.
 *
 *    (Contrast `./git.ts`, which does reimplement: `@slayzone/worktrees/server`
 *    drags in electron/React and would not bundle.)
 *
 * Every path argument is judged by the computer's one path jail (`../path-jail`)
 * before any access — the machine bound (`allowedRoots`, links, protected state)
 * and, for root-scoped ops, the workspace bound. Every WRITE is done by the jail
 * (`jailedFs`) on the judged path, never by re-resolving `root + rel`: the file
 * editor's own write ops did, and wrote through a link the jail had not judged (G1,
 * G4).
 *
 * @module computer/handlers/fs
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import {
  gitStatus as feGitStatus,
  discoverRepos as feDiscoverRepos,
  listAllFiles as feListAllFiles,
  readDir as feReadDir,
  readFile as feReadFile,
  searchFiles as feSearchFiles,
  subscribeFileWatcher
} from '@slayzone/file-editor/server'
import type { DirEntry, FileSearchResult, ReadFileResult } from '@slayzone/file-editor/shared'
import {
  FS_MAX_LIST_ALL_FILES,
  FS_MAX_SEARCH_RESULTS,
  fsCopyInParamsSchema,
  fsCopyParamsSchema,
  fsCreateDirParamsSchema,
  fsCreateFileParamsSchema,
  fsDeleteParamsSchema,
  fsDiscoverReposParamsSchema,
  fsGitStatusParamsSchema,
  fsListAllFilesParamsSchema,
  fsListDirParamsSchema,
  fsListRootsParamsSchema,
  fsMkdirParamsSchema,
  fsPathExistsParamsSchema,
  fsReadDirParamsSchema,
  fsReadFileParamsSchema,
  fsRemoveDirParamsSchema,
  fsRenameParamsSchema,
  fsSearchFilesParamsSchema,
  fsWatchStartParamsSchema,
  fsWatchStopParamsSchema,
  fsWriteFileParamsSchema,
  HubToComputerMethods,
  ComputerNotificationMethods,
  type FsChangeParams,
  type FsDiscoverReposResult,
  type FsGitStatusResult,
  type FsListDirEntry,
  type FsListDirResult,
  type FsListRootsResult,
  type FsReadDirResult,
  type FsReadFileResult,
  type FsSearchFilesResult
} from '@slayzone/computer-transport/shared'
import { isProtectedPath, jailedFs, judgePath, judgePathIn, type JailOptions } from '../path-jail'
import type { HandlerContext, HubMethodTable } from './types'

/**
 * Compile-time pins between the wire schemas and the file-editor types they
 * describe. The frames package cannot import file-editor (it would take on the
 * dependency for types alone), so this module — the one place that imports both
 * — is where a shape divergence has to fail. Widening `DirEntry` without
 * widening `fsDirEntrySchema` breaks the build here rather than at runtime on a
 * remote computer, which is the failure mode this codebase has already paid for
 * four times over in the git and proc frames.
 */
type _AssertDirEntry = DirEntry extends FsReadDirResult['entries'][number] ? true : never
type _AssertReadFile = ReadFileResult extends FsReadFileResult ? true : never
type _AssertSearch = FileSearchResult extends FsSearchFilesResult['results'][number] ? true : never
const _typePins: [_AssertDirEntry, _AssertReadFile, _AssertSearch] = [true, true, true]
void _typePins

/** Directories never worth showing in a picker, even with `includeHidden`. */
const BROWSE_ALWAYS_HIDDEN = new Set(['.git', '.DS_Store', 'node_modules'])

export interface FsHandlers {
  handlers: HubMethodTable
  /**
   * Close every live watch (called on computer shutdown). A watch is an event-loop
   * handle: one left open keeps a stopped computer's process alive, because its
   * SIGTERM path relies on the loop draining to exit.
   */
  disposeAll(): void
}

export function createFsHandlers(ctx: HandlerContext): FsHandlers {
  // Read the jail through `ctx` on EVERY call rather than capturing the array at
  // construction: `computer.setAllowedRoots` edits it live (same shared-ctx trick
  // as `setAgentHookUrl`), and a captured reference would keep enforcing the
  // boot-time set — the user widens the roots in Settings, the UI reports
  // success, and the computer silently keeps refusing.
  const allow = (candidate: string, opts?: JailOptions): string =>
    judgePath(candidate, ctx.config.allowedRoots, opts)
  /**
   * Judge a ROOT-SCOPED op's target (T-27) — the root alone would let `fs.writeFile`
   * reach the computer's own `computer.config.json` whenever an allowed root
   * contains it. Returns the judged root and target.
   */
  const allowIn = (rootPath: string, rel: string, opts?: JailOptions) =>
    judgePathIn(rootPath, rel, ctx.config.allowedRoots, opts)

  /** Live watches, keyed by the hub-minted watchId. */
  const watches = new Map<string, () => void>()

  // --- raw probes -----------------------------------------------------------

  function pathExists(rawParams: unknown): { exists: boolean } {
    const { path } = fsPathExistsParamsSchema.parse(rawParams)
    const resolved = allow(path)
    return { exists: existsSync(resolved) }
  }

  async function removeDir(rawParams: unknown): Promise<{ ok: true }> {
    const { path } = fsRemoveDirParamsSchema.parse(rawParams)
    const resolved = allow(path, { access: 'entry', subtree: true })
    jailedFs.remove(resolved, { force: true })
    ctx.log('fs removeDir', { path: resolved })
    return { ok: true }
  }

  // --- workspace browse -----------------------------------------------------

  /**
   * The computer's browsable roots ARE its path-jail — there is nothing else it
   * would be willing to open. Roots are realpath-resolved so the client's
   * subsequent `fs.listDir` calls compare equal to what the jail returns; a
   * configured root that does not exist is dropped rather than offered as a
   * dead-end.
   */
  function listRoots(rawParams: unknown): FsListRootsResult {
    fsListRootsParamsSchema.parse(rawParams ?? {})
    const resolvedRoots: string[] = []
    for (const root of ctx.config.allowedRoots) {
      try {
        resolvedRoots.push(realpathSync.native(resolve(root)))
      } catch {
        /* configured but absent — cannot be browsed */
      }
    }
    let home: string | null = null
    try {
      home = realpathSync.native(homedir())
    } catch {
      home = null
    }
    return { roots: resolvedRoots, home, platform: process.platform, sep }
  }

  /**
   * List one directory by ABSOLUTE path.
   *
   * `parent` is null when the listed dir is itself an allowed root — the picker
   * uses that to stop offering "up", since a `..` from a root would be refused
   * by the jail anyway and a dead affordance reads as a bug.
   */
  async function listDir(rawParams: unknown): Promise<FsListDirResult> {
    const params = fsListDirParamsSchema.parse(rawParams)
    const abs = allow(params.path)

    const dirents = await readdir(abs, { withFileTypes: true })
    const entries: FsListDirEntry[] = []
    for (const e of dirents) {
      if (BROWSE_ALWAYS_HIDDEN.has(e.name)) continue
      if (!params.includeHidden && e.name.startsWith('.')) continue

      const full = join(abs, e.name)
      const symlink = e.isSymbolicLink()
      let isDir = e.isDirectory()
      if (symlink) {
        // A symlink's own dirent says "symlink", not what it points at. Stat
        // through it; a broken link stats nothing and is simply skipped.
        try {
          isDir = (await stat(full)).isDirectory()
        } catch {
          continue
        }
      }
      if (params.dirsOnly && !isDir) continue

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

    const isRoot = ctx.config.allowedRoots.some((r) => {
      try {
        return realpathSync.native(resolve(r)) === abs
      } catch {
        return false
      }
    })
    return { path: abs, parent: isRoot ? null : dirname(abs), entries }
  }

  async function mkdirHandler(rawParams: unknown): Promise<{ path: string }> {
    const { path } = fsMkdirParamsSchema.parse(rawParams)
    const abs = allow(path, { access: 'write' })
    jailedFs.mkdir(abs)
    ctx.log('fs mkdir', { path: abs })
    // Re-resolve: the jail tolerates a non-existent tail, so the pre-create path
    // may still contain an uncollapsed symlinked ancestor.
    return { path: realpathSync.native(abs) }
  }

  // --- file editor ----------------------------------------------------------

  function readDirHandler(rawParams: unknown): FsReadDirResult {
    const { rootPath, dirPath } = fsReadDirParamsSchema.parse(rawParams)
    return { entries: feReadDir(allow(rootPath), dirPath) }
  }

  function readFileHandler(rawParams: unknown): FsReadFileResult {
    const { rootPath, filePath, force } = fsReadFileParamsSchema.parse(rawParams)
    const { root } = allowIn(rootPath, filePath)
    return feReadFile(root, filePath, force)
  }

  function writeFileHandler(rawParams: unknown): { ok: true } {
    const { rootPath, filePath, content } = fsWriteFileParamsSchema.parse(rawParams)
    jailedFs.writeFile(allowIn(rootPath, filePath, { access: 'write' }).path, content)
    return { ok: true }
  }

  function createFileHandler(rawParams: unknown): { ok: true } {
    const { rootPath, filePath } = fsCreateFileParamsSchema.parse(rawParams)
    jailedFs.createFile(allowIn(rootPath, filePath, { access: 'write' }).path)
    return { ok: true }
  }

  function createDirHandler(rawParams: unknown): { ok: true } {
    const { rootPath, dirPath } = fsCreateDirParamsSchema.parse(rawParams)
    jailedFs.mkdir(allowIn(rootPath, dirPath, { access: 'write' }).path)
    return { ok: true }
  }

  function renameHandler(rawParams: unknown): { ok: true } {
    const { rootPath, oldPath, newPath } = fsRenameParamsSchema.parse(rawParams)
    const entry = { access: 'entry', subtree: true } as const
    jailedFs.rename(allowIn(rootPath, oldPath, entry).path, allowIn(rootPath, newPath, entry).path)
    return { ok: true }
  }

  function deleteHandler(rawParams: unknown): { ok: true } {
    const { rootPath, targetPath } = fsDeleteParamsSchema.parse(rawParams)
    // The entry itself: deleting a link removes the link, never what it points at.
    jailedFs.remove(allowIn(rootPath, targetPath, { access: 'entry', subtree: true }).path)
    return { ok: true }
  }

  /**
   * Copy a file from elsewhere on this machine into the workspace, under a free
   * name (`a.png`, `a (1).png`, …). `absoluteSrc` is judged in its own right; each
   * candidate name is created exclusively, so a name taken by a dangling link is
   * skipped, never written through (G4).
   */
  function copyInHandler(rawParams: unknown): { path: string } {
    const { rootPath, absoluteSrc, targetDir } = fsCopyInParamsSchema.parse(rawParams)
    const src = allow(absoluteSrc)
    let isFile = false
    try {
      isFile = statSync(src).isFile()
    } catch {
      /* missing */
    }
    if (!isFile) throw new Error('Source is not a file')
    const dirRel = (targetDir ?? '').trim()
    const dir = allowIn(rootPath, dirRel, { access: 'write' }).path
    const ext = extname(src)
    const stem = basename(src, ext)
    for (let i = 0; ; i++) {
      const name = i === 0 ? basename(src) : `${stem} (${i})${ext}`
      if (jailedFs.copyFileToNew(src, allow(join(dir, name), { access: 'entry' }))) {
        return { path: dirRel ? `${dirRel}/${name}` : name }
      }
    }
  }

  function copyHandler(rawParams: unknown): { ok: true } {
    const { rootPath, srcPath, destPath } = fsCopyParamsSchema.parse(rawParams)
    jailedFs.copy(
      allowIn(rootPath, srcPath).path,
      allowIn(rootPath, destPath, { access: 'write', subtree: true }).path
    )
    return { ok: true }
  }

  async function gitStatusHandler(rawParams: unknown): Promise<FsGitStatusResult> {
    const { rootPath } = fsGitStatusParamsSchema.parse(rawParams)
    return feGitStatus(allow(rootPath))
  }

  function searchFilesHandler(rawParams: unknown): FsSearchFilesResult {
    const { rootPath, query, options } = fsSearchFilesParamsSchema.parse(rawParams)
    // Clamp rather than reject: a caller asking for more than the wire allows
    // should get the wire's maximum plus an honest `truncated`, not an error.
    const maxResults = Math.min(options?.maxResults ?? FS_MAX_SEARCH_RESULTS, FS_MAX_SEARCH_RESULTS)
    const root = allow(rootPath)
    // Content search reads every file below the root; a root above the computer's
    // own state must not hand back lines of its credentials or request log (T-27).
    const results = feSearchFiles(root, query, {
      ...options,
      maxResults
    }).filter((r) => !isProtectedPath(join(root, r.path)))
    const total = results.reduce((n, r) => n + r.matches.length, 0)
    return { results, truncated: total >= maxResults }
  }

  function listAllFilesHandler(rawParams: unknown): {
    files: string[]
    truncated: boolean
  } {
    const { rootPath } = fsListAllFilesParamsSchema.parse(rawParams)
    const all = feListAllFiles(allow(rootPath))
    return {
      files: all.slice(0, FS_MAX_LIST_ALL_FILES),
      truncated: all.length > FS_MAX_LIST_ALL_FILES
    }
  }

  /**
   * Start a watch, streaming each change back as an `fs.change` notification
   * tagged with the hub's `watchId`.
   *
   * Idempotent on `watchId`: a hub retry after a reconnect must not leave two
   * subscriptions feeding one client (the panel would then see every change
   * twice and refetch twice).
   */
  async function discoverReposHandler(rawParams: unknown): Promise<FsDiscoverReposResult> {
    const { rootPath, maxDepth } = fsDiscoverReposParamsSchema.parse(rawParams)
    return { repos: await feDiscoverRepos(allow(rootPath), maxDepth) }
  }

  function watchStart(rawParams: unknown): { ok: true } {
    const { watchId, rootPath } = fsWatchStartParamsSchema.parse(rawParams)
    watches.get(watchId)?.()
    const abs = allow(rootPath)
    const dispose = subscribeFileWatcher(abs, (e) => {
      const params: FsChangeParams = { watchId, type: e.type, relPath: e.relPath }
      ctx.dialer.notify(ComputerNotificationMethods.fsChange, params)
    })
    watches.set(watchId, dispose)
    return { ok: true }
  }

  function watchStop(rawParams: unknown): { ok: true } {
    const { watchId } = fsWatchStopParamsSchema.parse(rawParams)
    watches.get(watchId)?.()
    watches.delete(watchId)
    return { ok: true }
  }

  function disposeAll(): void {
    for (const [watchId, dispose] of watches) {
      dispose()
      ctx.log('fs watch disposed on shutdown', { watchId })
    }
    watches.clear()
  }

  const handlers: HubMethodTable = {
    [HubToComputerMethods.fsPathExists]: pathExists,
    [HubToComputerMethods.fsRemoveDir]: removeDir,

    [HubToComputerMethods.fsListRoots]: listRoots,
    [HubToComputerMethods.fsListDir]: listDir,
    [HubToComputerMethods.fsMkdir]: mkdirHandler,

    [HubToComputerMethods.fsReadDir]: readDirHandler,
    [HubToComputerMethods.fsReadFile]: readFileHandler,
    [HubToComputerMethods.fsWriteFile]: writeFileHandler,
    [HubToComputerMethods.fsCreateFile]: createFileHandler,
    [HubToComputerMethods.fsCreateDir]: createDirHandler,
    [HubToComputerMethods.fsRename]: renameHandler,
    [HubToComputerMethods.fsDelete]: deleteHandler,
    [HubToComputerMethods.fsCopyIn]: copyInHandler,
    [HubToComputerMethods.fsCopy]: copyHandler,
    [HubToComputerMethods.fsGitStatus]: gitStatusHandler,
    [HubToComputerMethods.fsSearchFiles]: searchFilesHandler,
    [HubToComputerMethods.fsListAllFiles]: listAllFilesHandler,
    [HubToComputerMethods.fsDiscoverRepos]: discoverReposHandler,
    [HubToComputerMethods.fsWatchStart]: watchStart,
    [HubToComputerMethods.fsWatchStop]: watchStop
  }

  return { handlers, disposeAll }
}
