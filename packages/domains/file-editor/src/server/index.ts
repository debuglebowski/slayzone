export {
  ALWAYS_IGNORED,
  MAX_FILE_SIZE,
  FORCE_MAX_FILE_SIZE,
  assertWithinRoot,
  getIgnoreFilter,
  invalidateIgnoreCache,
  clearIgnoreCache,
  isIgnored,
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
