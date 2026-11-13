/**
 * File editor router — every call routed to the machine that owns the workspace.
 *
 * These used to call `@slayzone/file-editor/server` directly, i.e. against the
 * HUB's disk. For a task whose checkout lives on a computer that is the wrong
 * filesystem entirely: the tree showed the hub's files, a save wrote them there,
 * and the agent working in the real checkout saw none of it. Same defect as the
 * project-path probe, one panel over.
 *
 * Every procedure names its PATH SCOPE (§9 Phase 7b): the task or project whose
 * files it touches (`computerId` may pick among a project's computers), resolved by
 * `WorkspaceDeps.resolveComputer` — the same resolution a pty spawn uses, so the
 * editor and the agent always see one filesystem. The hub authorizes the scope and
 * sends the call under it (`@slayzone/platform/path-scope`); the computer confines
 * `rootPath` and every path below it to that scope's own folders, which only it
 * knows. A call naming neither is refused, and so is one with no computer to run
 * on: the hub's own disk is never the editor's (it cannot confine a scope there).
 *
 * `rootPath` still bounds every relative path (file-editor's own
 * `assertWithinRoot`), and the computer's path jail bounds `rootPath` in turn.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import type { SlayzoneDb } from '@slayzone/platform'
import { isHubSwitchedOffError, refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import {
  inPathScopeOf,
  PathScopeRequiredError,
  pathScopeFor,
  runInPathScope
} from '@slayzone/platform/path-scope'
import type { FileWatchEvent } from './watcher'
import type { SearchFilesOptions } from '../shared'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getWorkspaceDeps } from './workspace-deps'
import { getFileEditorRouterDeps } from './file-editor-router-deps'

const searchOptions = z.unknown() as unknown as z.ZodType<SearchFilesOptions>

/** Which machine the call is for. See the module note on resolution order. */
const target = {
  computerId: z.string().nullable().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional()
}

type Target = { computerId?: string | null; taskId?: string; projectId?: string }

/** The computer of the call's scope; none = refused (never the hub's own disk). */
const resolve = async (input: Target): Promise<string> => {
  const computerId = await getWorkspaceDeps().resolveComputer(input)
  return computerId ?? refuseNoComputer({ op: 'fileEditor' })
}

/** Run `fn` in the call's path scope (its task, else its project), or refuse. */
const inScope = <T>(db: SlayzoneDb, input: Target, fn: () => Promise<T>): Promise<T> =>
  inPathScopeOf(db, input, 'fileEditor', fn)

/** The path scope a call names: its task, else its project (required, typed so). */
export type FileEditorScope = { computerId?: string | null } & (
  | { taskId: string; projectId?: string }
  | { taskId?: undefined; projectId: string }
)

/**
 * A scoped input: the target fields plus `shape`, naming a task or project. Typed
 * as that scope, so a caller naming neither fails typecheck; validated at run time
 * too.
 */
const scoped = <S extends z.ZodRawShape>(shape: S) =>
  z
    .object({ ...target, ...shape })
    .refine(
      (v) => !!(v as Target).taskId || !!(v as Target).projectId,
      'name the task or project (taskId / projectId)'
    ) as unknown as z.ZodType<
    z.infer<z.ZodObject<S>> & FileEditorScope,
    z.input<z.ZodObject<S>> & FileEditorScope
  >

const fs = () => getWorkspaceDeps().fs

export const fileEditorRouter = router({
  readDir: publicProcedure
    .input(scoped({ rootPath: z.string(), dirPath: z.string() }))
    .query(({ ctx, input }) =>
      inScope(ctx.db, input, async () =>
        fs().readDir(await resolve(input), input.rootPath, input.dirPath)
      )
    ),

  readFile: publicProcedure
    .input(scoped({ rootPath: z.string(), filePath: z.string(), force: z.boolean().optional() }))
    .query(({ ctx, input }) =>
      inScope(ctx.db, input, async () =>
        fs().readFile(await resolve(input), input.rootPath, input.filePath, input.force)
      )
    ),

  /**
   * Whole-tree read, capped at the transport layer. `truncated` is preserved
   * rather than dropped: a partial tree presented as complete is how a
   * quick-open silently stops finding files.
   */
  listAllFiles: publicProcedure
    .input(scoped({ rootPath: z.string() }))
    .query(({ ctx, input }) =>
      inScope(ctx.db, input, async () => fs().listAllFiles(await resolve(input), input.rootPath))
    ),

  writeFile: publicProcedure
    .input(scoped({ rootPath: z.string(), filePath: z.string(), content: z.string() }))
    .mutation(({ ctx, input }) =>
      inScope(ctx.db, input, async () => {
        await fs().writeFile(await resolve(input), input.rootPath, input.filePath, input.content)
      })
    ),

  createFile: publicProcedure
    .input(scoped({ rootPath: z.string(), filePath: z.string() }))
    .mutation(({ ctx, input }) =>
      inScope(ctx.db, input, async () => {
        await fs().createFile(await resolve(input), input.rootPath, input.filePath)
      })
    ),

  createDir: publicProcedure
    .input(scoped({ rootPath: z.string(), dirPath: z.string() }))
    .mutation(({ ctx, input }) =>
      inScope(ctx.db, input, async () => {
        await fs().createDir(await resolve(input), input.rootPath, input.dirPath)
      })
    ),

  rename: publicProcedure
    .input(scoped({ rootPath: z.string(), oldPath: z.string(), newPath: z.string() }))
    .mutation(({ ctx, input }) =>
      inScope(ctx.db, input, async () => {
        await fs().rename(await resolve(input), input.rootPath, input.oldPath, input.newPath)
      })
    ),

  delete: publicProcedure
    .input(scoped({ rootPath: z.string(), targetPath: z.string() }))
    .mutation(({ ctx, input }) =>
      inScope(ctx.db, input, async () => {
        await fs().delete(await resolve(input), input.rootPath, input.targetPath)
      })
    ),

  /**
   * Copy a file picked on the computer's machine into the workspace. Its source is
   * confined to the scope too, except on a hub without login (its one local user:
   * a desktop drag from Finder), where the machine bound applies as before.
   */
  copyIn: publicProcedure
    .input(
      scoped({ rootPath: z.string(), absoluteSrc: z.string(), targetDir: z.string().optional() })
    )
    .mutation(({ ctx, input }) =>
      inScope(ctx.db, input, async () =>
        fs().copyIn(await resolve(input), input.rootPath, input.absoluteSrc, input.targetDir)
      )
    ),

  copy: publicProcedure
    .input(scoped({ rootPath: z.string(), srcPath: z.string(), destPath: z.string() }))
    .mutation(({ ctx, input }) =>
      inScope(ctx.db, input, async () => {
        await fs().copy(await resolve(input), input.rootPath, input.srcPath, input.destPath)
      })
    ),

  gitStatus: publicProcedure
    .input(scoped({ rootPath: z.string() }))
    .query(({ ctx, input }) =>
      inScope(ctx.db, input, async () => fs().gitStatus(await resolve(input), input.rootPath))
    ),

  searchFiles: publicProcedure
    .input(scoped({ rootPath: z.string(), query: z.string(), options: searchOptions.optional() }))
    .query(({ ctx, input }) =>
      inScope(ctx.db, input, async () =>
        fs().searchFiles(await resolve(input), input.rootPath, input.query, input.options)
      )
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
      getFileEditorRouterDeps().shellShowItemInFolder(abs)
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
  watch: publicProcedure.input(scoped({ rootPath: z.string() })).subscription(({ ctx, input }) =>
    observable<FileWatchEvent>((emit) => {
      let dispose: (() => void) | null = null
      let cancelled = false
      Promise.all([resolve(input), pathScopeFor(ctx.db, input)])
        .then(([computerId, scope]) => {
          if (cancelled) return
          if (!scope) throw new PathScopeRequiredError('fileEditor.watch')
          // Started inside the scope: the computer confines the watched root to it.
          dispose = runInPathScope(scope, () =>
            fs().watch(computerId, input.rootPath, (e) => emit.next(e))
          )
        })
        .catch((err: unknown) => {
          // The stream's own error. Floated, a refusal here (processes off and no
          // computer connected) had no handler and ended the hub's process (T-102).
          if (cancelled) return
          emit.error(
            isHubSwitchedOffError(err)
              ? new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err })
              : err
          )
        })
      return () => {
        cancelled = true
        dispose?.()
      }
    })
  )
})

export type FileEditorRouter = typeof fileEditorRouter
/** Where api mounts this domain's router (`router.ts`). */
export type FileEditorMounts = { fileEditor: FileEditorRouter }
