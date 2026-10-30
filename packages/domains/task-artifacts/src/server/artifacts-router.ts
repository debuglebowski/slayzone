import { realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import {
  assertHubLocalExecEnabled,
  hubProcessesEnabled
} from '@slayzone/platform/hub-switch-refusal'
import {
  artifactWatcherEvents,
  downloadArtifactFile,
  downloadArtifactFolder,
  downloadArtifactAsPdf,
  downloadArtifactAsPng,
  downloadArtifactAsHtml,
  downloadAllArtifactsAsZip
} from '@slayzone/task/server'
import type {
  CreateArtifactInput,
  UpdateArtifactInput,
  CreateArtifactFolderInput,
  UpdateArtifactFolderInput
} from '@slayzone/task-contracts'
import type { SlayzoneDb } from '@slayzone/platform'
import { router, publicProcedure, hubLocalProcedure } from '@slayzone/trpc-server'
import { createArtifactStore, type ArtifactStore } from './artifact-store'
import { getArtifactsRouterDeps, signalTasksChanged } from './artifacts-router-deps'

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

// Every write tells the other clients when it changed what `getByTask` or
// `foldersGetByTask` answers for a task — `notify.onTasksChanged` naming that task,
// the signal clients already refresh those per-task queries on (a dedicated
// artifacts stream would duplicate its scoping, coalescing and owner filtering).
// A write that leaves both lists as they were (the editor's content autosave: the
// working copy is not in them) says nothing; the file watcher's `onContentChanged`
// covers content.

/** The tasks that own these rows. */
async function taskIdsOf(
  db: SlayzoneDb,
  table: 'task_artifacts' | 'artifact_folders',
  ids: readonly string[]
): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db.all<{ task_id: string }>(
    `SELECT DISTINCT task_id FROM ${table} WHERE id IN (${ids.map(() => '?').join(', ')})`,
    [...ids]
  )
  return rows.map((r) => r.task_id)
}

const folderRow = (db: SlayzoneDb, id: string) =>
  db.get<Record<string, unknown> & { task_id: string }>(
    'SELECT * FROM artifact_folders WHERE id = ?',
    [id]
  )

/** Run a write to one artifact; signal its task when the row `getByTask` lists for it changed. */
async function changingArtifact<T>(
  s: ArtifactStore,
  db: SlayzoneDb,
  artifactId: string,
  write: () => Promise<T>
): Promise<T> {
  const before = await s.getArtifact(db, artifactId)
  const result = await write()
  const after = await s.getArtifact(db, artifactId)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    signalTasksChanged([before?.task_id, after?.task_id])
  }
  return result
}

/** Run a write to one folder; signal its task when the folder's row changed. */
async function changingFolder<T>(
  db: SlayzoneDb,
  folderId: string,
  write: () => Promise<T>
): Promise<T> {
  const before = await folderRow(db, folderId)
  const result = await write()
  const after = await folderRow(db, folderId)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    signalTasksChanged([before?.task_id, after?.task_id])
  }
  return result
}

/** Run a write that creates artifacts / folders; signal the tasks it created them in. */
async function creating<T>(
  write: () => Promise<T>,
  tasksOf: (result: T) => Iterable<string | null | undefined>
): Promise<T> {
  const result = await write()
  signalTasksChanged(tasksOf(result))
  return result
}

const realOrResolved = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/**
 * `upload`, `uploadDir` and `pasteFiles` copy a path the CLIENT names off the hub's
 * own disk (T-107). The owner gate has decided the path is the caller's; on a hub with
 * processes switched off (T-06) that is not enough, because such a hub holds no
 * project files: the path is a file on the client's machine the hub cannot read, or
 * one of the hub's own. `upload` and `uploadDir` are `hubLocalProcedure`s (refused
 * outright); a paste may still copy hub storage — another artifact's file under
 * `<data root>/artifacts/`, which is how copy/paste and duplicate work — and nothing
 * else, before anything is read.
 */
function assertPasteSourcesAreHubStorage(dataRoot: string, sources: unknown): void {
  if (hubProcessesEnabled()) return
  const artifacts = realOrResolved(join(dataRoot, 'artifacts')) + sep
  for (const src of Array.isArray(sources) ? sources : []) {
    if (typeof src !== 'string' || !realOrResolved(src).startsWith(artifacts))
      assertHubLocalExecEnabled({ op: 'artifacts.pasteFiles' })
  }
}

// Host-only steps of a download (save sheet, directory picker, downloads dir, reveal,
// offscreen PDF/PNG render) come from the host's capability bridge, injected through
// `setArtifactsRouterDeps` (api wires it from AppDeps). Previously these procedures
// reached the electron-side download module through a catch-guarded dynamic import,
// which cannot work in the plain-node side-car the renderer now talks to: the module
// bundles fine, so the "absent" branch never fired, and its electron binding resolved
// to a string path. AppDeps is compile-enforced at all three wiring sites, so a missing
// capability is a build error rather than a silent no-op.
const downloadHost = () => getArtifactsRouterDeps().getDownloadHost()

export const artifactsRouter = router({
  // --- Artifact CRUD / read ---
  getByTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).listArtifactsByTask(ctx.db, input.taskId)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).getArtifact(ctx.db, input.id)),

  create: publicProcedure.input(createArtifactInput).mutation(({ ctx, input }) =>
    creating(
      () => store(ctx.dataRoot).createArtifact(ctx.db, input),
      (a) => [a?.task_id]
    )
  ),

  update: publicProcedure.input(updateArtifactInput).mutation(({ ctx, input }) => {
    const s = store(ctx.dataRoot)
    return changingArtifact(s, ctx.db, input.id, () => s.updateArtifact(ctx.db, input))
  }),

  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
    const s = store(ctx.dataRoot)
    return changingArtifact(s, ctx.db, input.id, () => s.deleteArtifact(ctx.db, input.id))
  }),

  reorder: publicProcedure.input(reorderInput).mutation(async ({ ctx, input }) => {
    const ids = Array.isArray(input) ? input : input.artifactIds
    const taskIds = await taskIdsOf(ctx.db, 'task_artifacts', ids)
    await store(ctx.dataRoot).reorderArtifacts(ctx.db, input)
    signalTasksChanged(taskIds)
  }),

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
  // `upload`/`uploadDir` read a client-named path off the hub's disk (see
  // assertPasteSourcesAreHubStorage); `uploadBlob` carries the bytes and never does.
  upload: hubLocalProcedure.input(uploadInput).mutation(({ ctx, input }) =>
    creating(
      () => store(ctx.dataRoot).uploadArtifact(ctx.db, input),
      (a) => [a?.task_id]
    )
  ),

  uploadBlob: publicProcedure.input(uploadBlobInput).mutation(({ ctx, input }) =>
    creating(
      () => store(ctx.dataRoot).uploadArtifactBlob(ctx.db, input),
      (a) => [a?.task_id]
    )
  ),

  pasteFiles: publicProcedure.input(pasteFilesInput).mutation(({ ctx, input }) => {
    assertPasteSourcesAreHubStorage(ctx.dataRoot, input.sourcePaths)
    return creating(
      () => store(ctx.dataRoot).pasteArtifactFiles(ctx.db, input),
      (rows) => rows.map((a) => a.task_id)
    )
  }),

  uploadDir: hubLocalProcedure.input(uploadDirInput).mutation(({ ctx, input }) =>
    creating(
      () => store(ctx.dataRoot).uploadArtifactDir(ctx.db, input),
      (r) => [...r.folders.map((f) => f.task_id), ...r.artifacts.map((a) => a.task_id)]
    )
  ),

  cleanupTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ ctx, input }) => {
      store(ctx.dataRoot).cleanupTaskArtifacts(input.taskId)
    }),

  // --- Versions ---
  versionsList: publicProcedure
    .input(
      z.object({
        artifactId: z.string(),
        limit: z.number().optional(),
        offset: z.number().optional()
      })
    )
    .query(({ ctx, input }) => store(ctx.dataRoot).listArtifactVersions(ctx.db, input)),

  versionsRead: publicProcedure
    .input(z.object({ artifactId: z.string(), versionRef }))
    .query(({ ctx, input }) => store(ctx.dataRoot).readArtifactVersion(ctx.db, input)),

  // A version write signals when it moved the artifact's row (its current version);
  // naming or pruning history does not, today — `changingArtifact` decides.
  versionsCreate: publicProcedure
    .input(z.object({ artifactId: z.string(), name: z.string().nullable().optional() }))
    .mutation(({ ctx, input }) => {
      const s = store(ctx.dataRoot)
      return changingArtifact(s, ctx.db, input.artifactId, () =>
        s.createArtifactVersion(ctx.db, input)
      )
    }),

  versionsRename: publicProcedure
    .input(z.object({ artifactId: z.string(), versionRef, newName: z.string().nullable() }))
    .mutation(({ ctx, input }) => {
      const s = store(ctx.dataRoot)
      return changingArtifact(s, ctx.db, input.artifactId, () =>
        s.renameArtifactVersion(ctx.db, input)
      )
    }),

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
    .mutation(({ ctx, input }) => {
      const s = store(ctx.dataRoot)
      return changingArtifact(s, ctx.db, input.artifactId, () =>
        s.pruneArtifactVersions(ctx.db, input)
      )
    }),

  versionsSetCurrent: publicProcedure
    .input(z.object({ artifactId: z.string(), versionRef }))
    .mutation(({ ctx, input }) => {
      const s = store(ctx.dataRoot)
      return changingArtifact(s, ctx.db, input.artifactId, () =>
        s.setCurrentArtifactVersion(ctx.db, input)
      )
    }),

  // --- Folders ---
  foldersGetByTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => store(ctx.dataRoot).listFoldersByTask(ctx.db, input.taskId)),

  foldersGetOrCreateByName: publicProcedure
    .input(z.object({ taskId: z.string(), name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const count = async (): Promise<number> =>
        (
          await ctx.db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM artifact_folders WHERE task_id = ?',
            [input.taskId]
          )
        )?.n ?? 0
      const before = await count()
      const folder = await store(ctx.dataRoot).getOrCreateFolderByName(ctx.db, input)
      // Only a create changes the task's folders; a get changes nothing.
      if ((await count()) !== before) signalTasksChanged([input.taskId])
      return folder
    }),

  foldersCreate: publicProcedure.input(createFolderInput).mutation(({ ctx, input }) =>
    creating(
      () => store(ctx.dataRoot).createFolder(ctx.db, input),
      (f) => [f?.task_id]
    )
  ),

  foldersUpdate: publicProcedure
    .input(updateFolderInput)
    .mutation(({ ctx, input }) =>
      changingFolder(ctx.db, input.id, () => store(ctx.dataRoot).updateFolder(ctx.db, input))
    ),

  foldersDelete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      changingFolder(ctx.db, input.id, () => store(ctx.dataRoot).deleteFolder(ctx.db, input.id))
    ),

  foldersReorder: publicProcedure
    .input(z.object({ parentId: z.string().nullable(), folderIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const taskIds = await taskIdsOf(ctx.db, 'artifact_folders', input.folderIds)
      await store(ctx.dataRoot).reorderFolders(ctx.db, input)
      signalTasksChanged(taskIds)
    }),

  // --- Download (needs the Electron host via AppDeps) ---
  downloadFile: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      downloadArtifactFile(downloadHost(), ctx.db, ctx.dataRoot, input.id)
    ),

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

export type ArtifactsRouter = typeof artifactsRouter

/** Where `@slayzone/api` mounts this router; it asserts the slice in its `router.ts`. */
export type ArtifactsMounts = { artifacts: ArtifactsRouter }
