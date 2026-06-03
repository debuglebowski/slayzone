import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import {
  readDir,
  readFile,
  listAllFiles,
  writeFile,
  createFile,
  createDir,
  renamePath,
  deletePath,
  copyIn,
  copy,
  gitStatus,
  searchFiles,
  assertWithinRoot,
  subscribeFileWatcher,
  type FileWatchEvent,
} from '@slayzone/file-editor/server'
import type { SearchFilesOptions } from '@slayzone/file-editor/shared'
import { router, publicProcedure } from '../trpc'

const searchOptions = z.unknown() as unknown as z.ZodType<SearchFilesOptions>

export const fileEditorRouter = router({
  readDir: publicProcedure
    .input(z.object({ rootPath: z.string(), dirPath: z.string() }))
    .query(({ input }) => readDir(input.rootPath, input.dirPath)),

  readFile: publicProcedure
    .input(z.object({ rootPath: z.string(), filePath: z.string(), force: z.boolean().optional() }))
    .query(({ input }) => readFile(input.rootPath, input.filePath, input.force)),

  listAllFiles: publicProcedure
    .input(z.object({ rootPath: z.string() }))
    .query(({ input }) => listAllFiles(input.rootPath)),

  writeFile: publicProcedure
    .input(z.object({ rootPath: z.string(), filePath: z.string(), content: z.string() }))
    .mutation(({ input }) => {
      writeFile(input.rootPath, input.filePath, input.content)
    }),

  createFile: publicProcedure
    .input(z.object({ rootPath: z.string(), filePath: z.string() }))
    .mutation(({ input }) => {
      createFile(input.rootPath, input.filePath)
    }),

  createDir: publicProcedure
    .input(z.object({ rootPath: z.string(), dirPath: z.string() }))
    .mutation(({ input }) => {
      createDir(input.rootPath, input.dirPath)
    }),

  rename: publicProcedure
    .input(z.object({ rootPath: z.string(), oldPath: z.string(), newPath: z.string() }))
    .mutation(({ input }) => {
      renamePath(input.rootPath, input.oldPath, input.newPath)
    }),

  delete: publicProcedure
    .input(z.object({ rootPath: z.string(), targetPath: z.string() }))
    .mutation(({ input }) => {
      deletePath(input.rootPath, input.targetPath)
    }),

  copyIn: publicProcedure
    .input(z.object({ rootPath: z.string(), absoluteSrc: z.string(), targetDir: z.string().optional() }))
    .mutation(({ input }) => copyIn(input.rootPath, input.absoluteSrc, input.targetDir)),

  copy: publicProcedure
    .input(z.object({ rootPath: z.string(), srcPath: z.string(), destPath: z.string() }))
    .mutation(({ input }) => {
      copy(input.rootPath, input.srcPath, input.destPath)
    }),

  gitStatus: publicProcedure
    .input(z.object({ rootPath: z.string() }))
    .query(({ input }) => gitStatus(input.rootPath)),

  searchFiles: publicProcedure
    .input(z.object({ rootPath: z.string(), query: z.string(), options: searchOptions.optional() }))
    .query(({ input }) => searchFiles(input.rootPath, input.query, input.options)),

  /**
   * Electron-only: shell.showItemInFolder. When running in standalone server
   * (no electron import), the procedure throws — surface it cleanly in the
   * UI as a hidden affordance per master §11d. Dynamic import keeps the
   * transport pkg loadable in non-Electron contexts.
   */
  showInFinder: publicProcedure
    .input(z.object({ rootPath: z.string(), targetPath: z.string() }))
    .mutation(async ({ input }) => {
      const path = await import('node:path')
      const abs = input.targetPath
        ? assertWithinRoot(input.rootPath, input.targetPath)
        : path.resolve(input.rootPath)
      const electron = (await import('electron').catch(() => null)) as typeof import('electron') | null
      if (!electron?.shell?.showItemInFolder) {
        throw new Error('showInFinder unavailable in this server context (Electron-only)')
      }
      electron.shell.showItemInFolder(abs)
    }),

  /**
   * Subscribe to file changes under rootPath. Emits 'changed' / 'deleted'
   * events with relative paths. Replaces the fs:watch + fs:changed +
   * fs:deleted IPC trio.
   */
  watch: publicProcedure
    .input(z.object({ rootPath: z.string() }))
    .subscription(({ input }) =>
      observable<FileWatchEvent>((emit) => {
        const unsubscribe = subscribeFileWatcher(input.rootPath, (e) => {
          emit.next(e)
        })
        return unsubscribe
      }),
    ),
})
