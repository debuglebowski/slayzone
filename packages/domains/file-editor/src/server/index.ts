export {
  ALWAYS_IGNORED,
  MAX_FILE_SIZE,
  FORCE_MAX_FILE_SIZE,
  assertWithinRoot,
  PathTraversalError,
  isPathTraversalError,
  WORKSPACE_READ_BYTES_MAX_CHUNK,
  readBytesAt,
  readBytes,
  type ReadBytesResult,
  getIgnoreFilter,
  invalidateIgnoreCache,
  clearIgnoreCache,
  isIgnored,
  readDir,
  readFile,
  textRevision,
  listAllFiles,
  writeFile,
  applyTextEdit,
  createFile,
  createDir,
  renamePath,
  deletePath,
  copyIn,
  copy,
  gitStatus,
  searchFiles
} from './file-ops'

export {
  subscribeFileWatcher,
  closeAllFileWatchers,
  type FileWatchEvent
} from './watcher'

export {
  discoverRepos,
  isGitRepoDir,
  DEFAULT_REPO_SCAN_DEPTH,
  type DiscoveredRepo,
  type DiscoveredRepoKind
} from './repo-discovery'

export {
  createLocalWorkspaceFs,
  createLocalWorkspaceFsAdapters,
  WORKSPACE_MAX_LIST_ALL_FILES,
  WORKSPACE_MAX_SEARCH_RESULTS,
  type BrowseEntry,
  type BrowseOptions,
  type BrowseResult,
  type ListAllFilesResult,
  type ProjectLocation,
  type LocalWorkspaceFs,
  type SearchResult,
  type SetRootsResult,
  type WorkspaceFsAdapters,
  type WorkspaceRoots
} from './workspace-fs'

export {
  setWorkspaceDeps,
  getWorkspaceDeps,
  type WorkspaceDeps,
  type WorkspaceComputerTarget
} from './workspace-deps'

export {
  fileEditorRouter,
  type FileEditorRouter,
  type FileEditorMounts
} from './file-editor-router'
export {
  setFileEditorRouterDeps,
  getFileEditorRouterDeps,
  type FileEditorRouterDeps
} from './file-editor-router-deps'
export { workspaceRouter, type WorkspaceRouter, type WorkspaceMounts } from './workspace-router'

export { noComputerWorkspaceFs, noComputerWorkspaceFsAdapters } from './workspace-fs-none'
