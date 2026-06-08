// cap-shell-6 — window.api.fs.* backed by sidecar `fs:*` handlers through
// JsonRpcHost. FileEditor's useFileEditor hook uses this surface to read /
// write files, walk the tree, search, run git-status, and (no-op in
// cap-shell-6) watch for external changes.
//
// The watch surface returns a fire-and-forget unsub — cap-shell-7 can wire
// real change events via the sidecar broadcast channel. Renderer falls back
// to manual refresh in the meantime.

import { jsonRpcCall } from '../transport/mojo'

interface ReadFileResult {
  content: string | null
  tooLarge?: boolean
  sizeBytes?: number
}

interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  ignored?: boolean
  isSymlink?: boolean
}

interface GitStatusMap {
  files: Record<string, string>
  isGitRepo: boolean
}

interface FileSearchResult {
  path: string
  matches: { line: number; col: number; lineText: string }[]
}

interface SearchFilesOptions {
  matchCase?: boolean
  regex?: boolean
  maxResults?: number
}

type FileChangedListener = (rootPath: string, relPath: string) => void

// Module-local set of fs:changed listeners. cap-shell-6 never fires these;
// cap-shell-7 subscribes to the sidecar notification channel and fans out.
const fileChangedListeners = new Set<FileChangedListener>()

export const fsShim = {
  readFile: (rootPath: string, filePath: string, force?: boolean): Promise<ReadFileResult> =>
    jsonRpcCall<ReadFileResult>('fs:readFile', { params: [rootPath, filePath, force ?? false] }),

  writeFile: async (rootPath: string, filePath: string, content: string): Promise<void> => {
    await jsonRpcCall('fs:writeFile', { params: [rootPath, filePath, content] })
  },

  readDir: (rootPath: string, dirPath: string): Promise<DirEntry[]> =>
    jsonRpcCall<DirEntry[]>('fs:readDir', { params: [rootPath, dirPath] }),

  listAllFiles: (rootPath: string): Promise<string[]> =>
    jsonRpcCall<string[]>('fs:listAllFiles', { params: [rootPath] }),

  createFile: async (rootPath: string, filePath: string): Promise<void> => {
    await jsonRpcCall('fs:createFile', { params: [rootPath, filePath] })
  },

  createDir: async (rootPath: string, dirPath: string): Promise<void> => {
    await jsonRpcCall('fs:createDir', { params: [rootPath, dirPath] })
  },

  rename: async (rootPath: string, oldPath: string, newPath: string): Promise<void> => {
    await jsonRpcCall('fs:rename', { params: [rootPath, oldPath, newPath] })
  },

  delete: async (rootPath: string, targetPath: string): Promise<void> => {
    await jsonRpcCall('fs:delete', { params: [rootPath, targetPath] })
  },

  copy: async (rootPath: string, srcPath: string, destPath: string): Promise<void> => {
    await jsonRpcCall('fs:copy', { params: [rootPath, srcPath, destPath] })
  },

  copyIn: (rootPath: string, absoluteSrc: string): Promise<string> =>
    jsonRpcCall<string>('fs:copyIn', { params: [rootPath, absoluteSrc] }),

  gitStatus: (rootPath: string): Promise<GitStatusMap> =>
    jsonRpcCall<GitStatusMap>('fs:gitStatus', { params: [rootPath] }),

  searchFiles: (
    rootPath: string,
    query: string,
    options?: SearchFilesOptions,
  ): Promise<FileSearchResult[]> =>
    jsonRpcCall<FileSearchResult[]>('fs:searchFiles', {
      params: [rootPath, query, options ?? {}],
    }),

  watch: (rootPath: string): void => {
    // Fire-and-forget — sidecar no-ops in cap-shell-6.
    void jsonRpcCall('fs:watch', { params: [rootPath] }).catch(() => {})
  },

  unwatch: (rootPath: string): void => {
    void jsonRpcCall('fs:unwatch', { params: [rootPath] }).catch(() => {})
  },

  showInFinder: (rootPath: string, targetPath: string): void => {
    void jsonRpcCall('fs:showInFinder', { params: [rootPath, targetPath] }).catch(() => {})
  },

  // Renderer expects `onFileChanged(cb) => unsub`. cap-shell-6 never fires
  // callbacks, but the unsub contract holds so subscribers clean up cleanly.
  onFileChanged: (cb: FileChangedListener): (() => void) => {
    fileChangedListeners.add(cb)
    return () => {
      fileChangedListeners.delete(cb)
    }
  },
}
