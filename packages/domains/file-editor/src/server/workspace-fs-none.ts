/**
 * The workspace filesystem of a host with no computer: the hub. Project files live
 * on computers, so every call is the actionable "connect a computer" — the hub never
 * reads or writes a project folder itself.
 */
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { LocalWorkspaceFs } from './workspace-fs'
import { adaptersOver } from './workspace-fs-adapters'

const none = (op: string) => (): never => refuseNoComputer({ op: `workspace.${op}` })

export const noComputerWorkspaceFs: LocalWorkspaceFs = {
  listRoots: none('listRoots'),
  listDir: none('listDir'),
  mkdir: none('mkdir'),
  pathExists: none('pathExists'),
  setAllowedRoots: none('setAllowedRoots'),
  discoverRepos: none('discoverRepos'),
  resolveProjectPath: none('resolveProjectPath'),
  setProjectPath: none('setProjectPath'),
  forgetProjectPath: none('forgetProjectPath'),
  readDir: none('readDir'),
  readFile: none('readFile'),
  writeFile: none('writeFile'),
  createFile: none('createFile'),
  createDir: none('createDir'),
  rename: none('rename'),
  delete: none('delete'),
  copyIn: none('copyIn'),
  copy: none('copy'),
  gitStatus: none('gitStatus'),
  searchFiles: none('searchFiles'),
  listAllFiles: none('listAllFiles'),
  watch: none('watch')
}

export const noComputerWorkspaceFsAdapters = adaptersOver(noComputerWorkspaceFs)
