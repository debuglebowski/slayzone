/**
 * File editor router — every call routed to the machine that owns the workspace.
 *
 * These used to call `@slayzone/file-editor/server` directly, i.e. against the
 * HUB's disk. For a task whose checkout lives on a computer that is the wrong
 * filesystem entirely: the tree showed the hub's files, a save wrote them there,
 * and the agent working in the real checkout saw none of it. Same defect as the
 * project-path probe, one panel over.
 *
 * Every procedure now carries an optional target (`computerId` | `taskId` |
 * `projectId`) resolved by `WorkspaceDeps.resolveComputer` — the same resolution a
 * pty spawn uses, so the editor and the agent always see one filesystem. Omitting
 * it resolves to the connected default computer, which is correct for the callers
 * that genuinely have no task context.
 *
 * `rootPath` still bounds every relative path (file-editor's own
 * `assertWithinRoot`), and on a computer the path-jail bounds `rootPath` in turn.
 */

import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import type { FileWatchEvent } from '@slayzone/file-editor/server'
import type { SearchFilesOptions } from '@slayzone/file-editor/shared'
import { router, publicProcedure } from '../trpc'
import { getAppDeps, getWorkspaceDeps } from '../app-deps'

const searchOptions = z.unknown() as unknown as z.ZodType<SearchFilesOptions>

/** Which machine the call is for. See the module note on resolution order. */
const target = {
  computerId: z.string().nullable().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional()
}

type Target = { computerId?: string | null; taskId?: string; projectId?: string }

const resolve = (input: Target): Promise<string | null> => getWorkspaceDeps().resolveComputer(input)

const fs = () => getWorkspaceDeps().fs

export const fileEditorRouter = router({
  readDir: publicProcedure
    .input(z.object({ ...target, rootPath: z.string(), dirPath: z.string() }))
    .query(async ({ input }) => fs().readDir(await resolve(input), input.rootPath, input.dirPath)),

  readFile: publicProcedure
    .input(
      z.object({
        ...target,
        rootPath: z.string(),
        filePath: z.string(),
        force: z.boolean().optional()
      })
    )
    .query(async ({ input }) =>
      fs().readFile(await resolve(input), input.rootPath, input.filePath, input.force)
    ),

  /**
   * Whole-tree read, capped at the transport layer. `truncated` is preserved
   * rather than dropped: a partial tree presented as complete is how a
   * quick-open silently stops finding files.
   */
  listAllFiles: publicProcedure
    .input(z.object({ ...target, rootPath: z.string() }))
    .query(async ({ input }) => fs().listAllFiles(await resolve(input), input.rootPath)),

  writeFile: publicProcedure
    .input(z.object({ ...target, rootPath: z.string(), filePath: z.string(), content: z.string() }))
    .mutation(async ({ input }) => {
      await fs().writeFile(await resolve(input), input.rootPath, input.filePath, input.content)
    }),

  createFile: publicProcedure
    .input(z.object({ ...target, rootPath: z.string(), filePath: z.string() }))
    .mutation(async ({ input }) => {
      await fs().createFile(await resolve(input), input.rootPath, input.filePath)
    }),

  createDir: publicProcedure
    .input(z.object({ ...target, rootPath: z.string(), dirPath: z.string() }))
    .mutation(async ({ input }) => {
      await fs().createDir(await resolve(input), input.rootPath, input.dirPath)
    }),

  rename: publicProcedure
    .input(z.object({ ...target, rootPath: z.string(), oldPath: z.string(), newPath: z.string() }))
    .mutation(async ({ input }) => {
      await fs().rename(await resolve(input), input.rootPath, input.oldPath, input.newPath)
    }),

  delete: publicProcedure
    .input(z.object({ ...target, rootPath: z.string(), targetPath: z.string() }))
    .mutation(async ({ input }) => {
      await fs().delete(await resolve(input), input.rootPath, input.targetPath)
    }),

  copyIn: publicProcedure
    .input(
      z.object({
        ...target,
        rootPath: z.string(),
        absoluteSrc: z.string(),
        targetDir: z.string().optional()
      })
    )
    .mutation(async ({ input }) =>
      fs().copyIn(await resolve(input), input.rootPath, input.absoluteSrc, input.targetDir)
    ),

  copy: publicProcedure
    .input(z.object({ ...target, rootPath: z.string(), srcPath: z.string(), destPath: z.string() }))
    .mutation(async ({ input }) => {
      await fs().copy(await resolve(input), input.rootPath, input.srcPath, input.destPath)
    }),

  gitStatus: publicProcedure
    .input(z.object({ ...target, rootPath: z.string() }))
    .query(async ({ input }) => fs().gitStatus(await resolve(input), input.rootPath)),

  searchFiles: publicProcedure
    .input(
      z.object({
        ...target,
        rootPath: z.string(),
        query: z.string(),
        options: searchOptions.optional()
      })
    )
    .query(async ({ input }) =>
      fs().searchFiles(await resolve(input), input.rootPath, input.query, input.options)
    ),

  /**
   * Reveal in the OS file manager.
   *
   * Deliberately NOT routed. There is no Finder on a headless computer, and even if
   * there were, revealing a folder on a machine the user is not sitting at is not
   * the action they asked for. The path resolves against the DESKTOP, so the UI
   * should only offer this when the workspace is co-resident — the caller decides.
   */
  showInFinder: publicProcedure
    .input(z.object({ rootPath: z.string(), targetPath: z.string() }))
    .mutation(async ({ input }) => {
      const path = await import('node:path')
      const abs = input.targetPath
        ? path.resolve(input.rootPath, input.targetPath)
        : path.resolve(input.rootPath)
      getAppDeps().shellShowItemInFolder(abs)
    }),

  /**
   * Subscribe to changes under rootPath.
   *
   * The source is the computer's watcher, streamed back as `fs.change` frames and
   * demuxed by a hub-minted watchId. A lost computer COMPLETES the stream rather
   * than going quiet, because a watcher that simply stops emitting is
   * indistinguishable from a directory that stopped changing — and the client
   * would keep showing a stale tree believing it was live.
   */
  watch: publicProcedure
    .input(z.object({ ...target, rootPath: z.string() }))
    .subscription(({ input }) =>
      observable<FileWatchEvent>((emit) => {
        let dispose: (() => void) | null = null
        let cancelled = false
        void resolve(input).then((computerId) => {
          if (cancelled) return
          dispose = fs().watch(computerId, input.rootPath, (e) => emit.next(e))
        })
        return () => {
          cancelled = true
          dispose?.()
        }
      })
    )
})
