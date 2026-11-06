/**
 * The routed seam over one `LocalWorkspaceFs`, ignoring `computerId`. Hub-safe: no
 * filesystem or git of its own — what runs is the `local` it is handed.
 */
import type { LocalWorkspaceFs, WorkspaceFsAdapters } from './workspace-fs'

export function adaptersOver(local: LocalWorkspaceFs): WorkspaceFsAdapters {
  return {
    listRoots: async () => local.listRoots(),
    listDir: async (_r, path, options) => local.listDir(path, options),
    mkdir: async (_r, path) => local.mkdir(path),
    pathExists: async (_r, path) => local.pathExists(path),
    setAllowedRoots: async (_r, roots) => local.setAllowedRoots(roots),
    resolveProjectPath: async (_r, projectId) => local.resolveProjectPath(projectId),
    setProjectPath: async (_r, projectId, path) => local.setProjectPath(projectId, path),
    forgetProjectPath: async (_r, projectId) => local.forgetProjectPath(projectId),

    readDir: async (_r, rootPath, dirPath) => local.readDir(rootPath, dirPath),
    readFile: async (_r, rootPath, filePath, force) => local.readFile(rootPath, filePath, force),
    writeFile: async (_r, rootPath, filePath, content) =>
      local.writeFile(rootPath, filePath, content),
    createFile: async (_r, rootPath, filePath) => local.createFile(rootPath, filePath),
    createDir: async (_r, rootPath, dirPath) => local.createDir(rootPath, dirPath),
    rename: async (_r, rootPath, oldPath, newPath) => local.rename(rootPath, oldPath, newPath),
    delete: async (_r, rootPath, targetPath) => local.delete(rootPath, targetPath),
    copyIn: async (_r, rootPath, absoluteSrc, targetDir) =>
      local.copyIn(rootPath, absoluteSrc, targetDir),
    copy: async (_r, rootPath, srcPath, destPath) => local.copy(rootPath, srcPath, destPath),
    gitStatus: async (_r, rootPath) => local.gitStatus(rootPath),
    searchFiles: async (_r, rootPath, query, options) =>
      local.searchFiles(rootPath, query, options),
    listAllFiles: async (_r, rootPath) => local.listAllFiles(rootPath),
    watch: (_r, rootPath, listener) => local.watch(rootPath, listener),
    discoverRepos: async (_r, rootPath, maxDepth) => local.discoverRepos(rootPath, maxDepth)
  }
}
