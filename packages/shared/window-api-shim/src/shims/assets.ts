// Phase-2 P2 — assets + assetFolders shims. Routes window.api.assets.*
// and window.api.assetFolders.* calls through `jsonRpcCall` to the
// matching sidecar handlers in packages/sidecar/src/handlers/assets.ts.
//
// onContentChanged is a no-op subscription in the shell build. The
// sidecar emits `assets:content-changed` broadcasts on mutate, but the
// renderer has no live back-channel from the sidecar yet — the returned
// unsubscribe keeps React cleanup happy. The AssetsPanel already polls
// mtime on focus, so asset file edits propagate on the next render
// without the live notification.

import type {
  TaskArtifact,
  ArtifactFolder,
  CreateArtifactInput,
  UpdateArtifactInput,
  CreateArtifactFolderInput,
  UpdateArtifactFolderInput,
} from '@slayzone/task/shared'
import { jsonRpcCall } from '../transport/mojo'

export const assetsShim = {
  getByTask: (taskId: string): Promise<TaskArtifact[]> =>
    jsonRpcCall<TaskArtifact[]>('db:assets:getByTask', { params: [taskId] }),

  get: (id: string): Promise<TaskArtifact | null> =>
    jsonRpcCall<TaskArtifact | null>('db:assets:get', { params: [id] }),

  create: (data: CreateArtifactInput): Promise<TaskArtifact> =>
    jsonRpcCall<TaskArtifact>('db:assets:create', data as unknown as Record<string, unknown>),

  update: (data: UpdateArtifactInput): Promise<TaskArtifact | null> =>
    jsonRpcCall<TaskArtifact | null>('db:assets:update', data as unknown as Record<string, unknown>),

  delete: (id: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assets:delete', { params: [id] }),

  reorder: async (
    data: string[] | { folderId: string | null; assetIds: string[] },
  ): Promise<void> => {
    await jsonRpcCall('db:assets:reorder', { params: [data] })
  },

  readContent: (id: string): Promise<string | null> =>
    jsonRpcCall<string | null>('db:assets:readContent', { params: [id] }),

  getFilePath: (id: string): Promise<string | null> =>
    jsonRpcCall<string | null>('db:assets:getFilePath', { params: [id] }),

  getMtime: (id: string): Promise<number | null> =>
    jsonRpcCall<number | null>('db:assets:getMtime', { params: [id] }),

  // No-op subscription — see header note. Returns a stable no-op unsubscribe.
  onContentChanged: (_callback: (assetId: string) => void): (() => void) => {
    return () => {
      /* no-op */
    }
  },

  upload: (data: { taskId: string; sourcePath: string; title?: string }): Promise<TaskArtifact> =>
    jsonRpcCall<TaskArtifact>('db:assets:upload', data as unknown as Record<string, unknown>),

  getFileSize: (id: string): Promise<number | null> =>
    jsonRpcCall<number | null>('db:assets:getFileSize', { params: [id] }),

  cleanupTask: async (taskId: string): Promise<void> => {
    await jsonRpcCall('db:assets:cleanupTask', { params: [taskId] })
  },

  uploadDir: (data: {
    taskId: string
    dirPath: string
    parentFolderId: string | null
  }): Promise<{ folders: ArtifactFolder[]; assets: TaskArtifact[] }> =>
    jsonRpcCall<{ folders: ArtifactFolder[]; assets: TaskArtifact[] }>(
      'db:assets:uploadDir',
      data as unknown as Record<string, unknown>,
    ),

  downloadFile: (id: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assets:downloadFile', { params: [id] }),

  downloadFolder: (id: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assets:downloadFolder', { params: [id] }),

  downloadAsPdf: (id: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assets:downloadAsPdf', { params: [id] }),

  downloadAsPng: (id: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assets:downloadAsPng', { params: [id] }),

  downloadAsHtml: (id: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assets:downloadAsHtml', { params: [id] }),

  downloadAllAsZip: (taskId: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assets:downloadAllAsZip', { params: [taskId] }),
}

export const assetFoldersShim = {
  getByTask: (taskId: string): Promise<ArtifactFolder[]> =>
    jsonRpcCall<ArtifactFolder[]>('db:assetFolders:getByTask', { params: [taskId] }),

  create: (data: CreateArtifactFolderInput): Promise<ArtifactFolder> =>
    jsonRpcCall<ArtifactFolder>('db:assetFolders:create', data as unknown as Record<string, unknown>),

  update: (data: UpdateArtifactFolderInput): Promise<ArtifactFolder | null> =>
    jsonRpcCall<ArtifactFolder | null>(
      'db:assetFolders:update',
      data as unknown as Record<string, unknown>,
    ),

  delete: (id: string): Promise<boolean> =>
    jsonRpcCall<boolean>('db:assetFolders:delete', { params: [id] }),

  reorder: async (data: { parentId: string | null; folderIds: string[] }): Promise<void> => {
    await jsonRpcCall('db:assetFolders:reorder', data as unknown as Record<string, unknown>)
  },
}
