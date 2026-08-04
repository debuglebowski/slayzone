import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import {
  createArtifactStore,
  artifactWatcherEvents,
  downloadArtifactFile,
  downloadArtifactFolder,
  downloadArtifactAsPdf,
  downloadArtifactAsPng,
  downloadArtifactAsHtml,
  downloadAllArtifactsAsZip,
  type ArtifactDownloadHost
} from '@slayzone/task/server'
import { getAppDeps } from '../app-deps'
import type {
  CreateArtifactInput,
  UpdateArtifactInput,
  CreateArtifactFolderInput,
  UpdateArtifactFolderInput
} from '@slayzone/task/shared'
import { router, publicProcedure } from '../trpc'

// Mirrors the 27 `db:artifacts:*` + 6 `db:artifactFolders:*` IPC handlers
// (task/src/main/handlers.ts) plus the `artifacts:content-changed` broadcast. The
// CRUD/version/folder/upload store is electron-free (@slayzone/task/server) and shared
// with the IPC handlers (coexistence until slice 5). The 6 download procedures need
// Electron dialogs + export renderers, which reach the host through the AppDeps
// capability bridge (see `downloadHost` below). Complex inputs pass through unchecked —
// the IPC path validates by TypeScript only.
const createArtifactInput = z.unknown() as unknown as z.ZodType<CreateArtifactInput>
const updateArtifactInput = z.unknown() as unknown as z.ZodType<
  UpdateArtifactInput & { mutateVersion?: boolean }
>
const reorderInput = z.unknown() as unknown as z.ZodType<
  string[] | { folderId: string | null; artifactIds: string[] }
>
const uploadInput = z.unknown() as unknown as z.ZodType<{
  taskId: string
  sourcePath: string
  title?: string
}>
const uploadBlobInput = z.unknown() as unknown as z.ZodType<{
  taskId: string
  title: string
  bytes: Uint8Array
  folderId?: string | null
}>
const pasteFilesInput = z.unknown() as unknown as z.ZodType<{
  sourcePaths: string[]
  destTaskId: string
  destFolderId: string | null
}>
const uploadDirInput = z.unknown() as unknown as z.ZodType<{
  taskId: string
  dirPath: string
  parentFolderId: string | null
}>
const createFolderInput = z.unknown() as unknown as z.ZodType<CreateArtifactFolderInput>
const updateFolderInput = z.unknown() as unknown as z.ZodType<UpdateArtifactFolderInput>
const versionRef = z.union([z.number(), z.string()])

const store = (dataRoot: string): ReturnType<typeof createArtifactStore> =>
  createArtifactStore(dataRoot)

// Host-only steps of a download (save sheet, directory picker, downloads dir, reveal,
// offscreen PDF/PNG render) come from the AppDeps capability bridge. Previously these
// procedures reached the electron-side download module through a catch-guarded dynamic
// import, which cannot work in the plain-node side-car the renderer now talks to: the
// module bundles fine, so the "absent" branch never fired, and its electron binding
// resolved to a string path. AppDeps is compile-enforced at all three wiring sites, so a
// missing capability is a build error rather than a silent no-op.
const downloadHost = (): ArtifactDownloadHost => {
  const deps = getAppDeps()
  return {
    showSaveDialog: deps.dialogShowSaveDialog,
    showOpenDialog: deps.dialogShowOpenDialog,
    getDownloadsDir: deps.appGetDownloadsDir,
    showItemInFolder: deps.shellShowItemInFolder,
    buildExportHtml: deps.artifactBuildExportHtml,
    renderPdfToFile: deps.artifactRenderPdfToFile,
    renderPngToFile: deps.artifactRenderPngToFile
  }
}

export const artifactsRouter = router({
  // --- Artifact CRUD / read ---
  getByTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).listArtifactsByTask(ctx.db, input.taskId)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).getArtifact(ctx.db, input.id)),

  create: publicProcedure
    .input(createArtifactInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).createArtifact(ctx.db, input)),

  update: publicProcedure
    .input(updateArtifactInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).updateArtifact(ctx.db, input)),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => store(ctx.dataRoot).deleteArtifact(ctx.db, input.id)),

  reorder: publicProcedure
    .input(reorderInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).reorderArtifacts(ctx.db, input)),

  readContent: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).readArtifactContent(ctx.db, input.id)),

  getFilePath: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).getArtifactPath(ctx.db, input.id)),

  getMtime: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).getArtifactMtime(ctx.db, input.id)),

  // --- Binary uploads (bytes via superjson) ---
  upload: publicProcedure
    .input(uploadInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).uploadArtifact(ctx.db, input)),

  uploadBlob: publicProcedure
    .input(uploadBlobInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).uploadArtifactBlob(ctx.db, input)),

  pasteFiles: publicProcedure
    .input(pasteFilesInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).pasteArtifactFiles(ctx.db, input)),

  uploadDir: publicProcedure
    .input(uploadDirInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).uploadArtifactDir(ctx.db, input)),

  cleanupTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ ctx, input }) => {
      store(ctx.dataRoot).cleanupTaskArtifacts(input.taskId)
    }),

  // --- Versions ---
  versionsList: publicProcedure
    .input(z.object({ artifactId: z.string(), limit: z.number().optional(), offset: z.number().optional() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).listArtifactVersions(ctx.db, input)),

  versionsRead: publicProcedure
    .input(z.object({ artifactId: z.string(), versionRef }))
    .query(({ ctx, input }) => store(ctx.dataRoot).readArtifactVersion(ctx.db, input)),

  versionsCreate: publicProcedure
    .input(z.object({ artifactId: z.string(), name: z.string().nullable().optional() }))
    .mutation(({ ctx, input }) => store(ctx.dataRoot).createArtifactVersion(ctx.db, input)),

  versionsRename: publicProcedure
    .input(z.object({ artifactId: z.string(), versionRef, newName: z.string().nullable() }))
    .mutation(({ ctx, input }) => store(ctx.dataRoot).renameArtifactVersion(ctx.db, input)),

  versionsDiff: publicProcedure
    .input(z.object({ artifactId: z.string(), a: versionRef, b: versionRef.optional() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).diffArtifactVersions(ctx.db, input)),

  versionsPrune: publicProcedure
    .input(
      z.object({
        artifactId: z.string(),
        keepLast: z.number().optional(),
        keepNamed: z.boolean().optional(),
        keepCurrent: z.boolean().optional(),
        dryRun: z.boolean().optional()
      })
    )
    .mutation(({ ctx, input }) => store(ctx.dataRoot).pruneArtifactVersions(ctx.db, input)),

  versionsSetCurrent: publicProcedure
    .input(z.object({ artifactId: z.string(), versionRef }))
    .mutation(({ ctx, input }) => store(ctx.dataRoot).setCurrentArtifactVersion(ctx.db, input)),

  // --- Folders ---
  foldersGetByTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).listFoldersByTask(ctx.db, input.taskId)),

  foldersGetOrCreateByName: publicProcedure
    .input(z.object({ taskId: z.string(), name: z.string() }))
    .mutation(({ ctx, input }) => store(ctx.dataRoot).getOrCreateFolderByName(ctx.db, input)),

  foldersCreate: publicProcedure
    .input(createFolderInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).createFolder(ctx.db, input)),

  foldersUpdate: publicProcedure
    .input(updateFolderInput)
    .mutation(({ ctx, input }) => store(ctx.dataRoot).updateFolder(ctx.db, input)),

  foldersDelete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => store(ctx.dataRoot).deleteFolder(ctx.db, input.id)),

  foldersReorder: publicProcedure
    .input(z.object({ parentId: z.string().nullable(), folderIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => store(ctx.dataRoot).reorderFolders(ctx.db, input)),

  // --- Download (needs the Electron host via AppDeps) ---
  downloadFile: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => downloadArtifactFile(downloadHost(), ctx.db, ctx.dataRoot, input.id)),

  downloadFolder: publicProcedure
    .input(z.object({ folderId: z.string() }))
    .mutation(({ ctx, input }) =>
      downloadArtifactFolder(downloadHost(), ctx.db, ctx.dataRoot, input.folderId)
    ),

  downloadAsPdf: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      downloadArtifactAsPdf(downloadHost(), ctx.db, ctx.dataRoot, input.id)
    ),

  downloadAsPng: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      downloadArtifactAsPng(downloadHost(), ctx.db, ctx.dataRoot, input.id)
    ),

  downloadAsHtml: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      downloadArtifactAsHtml(downloadHost(), ctx.db, ctx.dataRoot, input.id)
    ),

  downloadAllAsZip: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ ctx, input }) =>
      downloadAllArtifactsAsZip(downloadHost(), ctx.db, ctx.dataRoot, input.taskId)
    ),

  // --- Subscription ---
  // Fires when any artifact file changes on disk (fs.watch). Replaces the
  // `artifacts:content-changed` IPC broadcast once the renderer cuts over (slice 5).
  onContentChanged: publicProcedure.subscription(() =>
    observable<string>((emit) => {
      const handler = (artifactId: string): void => emit.next(artifactId)
      artifactWatcherEvents.on('content-changed', handler)
      return () => artifactWatcherEvents.off('content-changed', handler)
    })
  )
})
