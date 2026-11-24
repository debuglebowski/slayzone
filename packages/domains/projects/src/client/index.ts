export { CreateProjectDialog } from './CreateProjectDialog'
export type { ProjectCreationContext, ProjectStartMode } from './CreateProjectDialog'
export {
  ProjectSettingsPanel,
  type ProjectSettingsExtraTab,
  type ProjectSettingsHost,
  type ProjectSettingsPanelProps,
  type ProjectSettingsTab
} from './ProjectSettingsPanel'
export { ScopedRelocateProjectDialog } from './RelocateProjectDialog'
export { DeleteProjectDialog } from './DeleteProjectDialog'
export { GroupSettingsDialog } from './GroupSettingsDialog'
export { ProjectSelect } from './ProjectSelect'
export { SettingsTabIntro } from './project-settings-shared'
export {
  isRateLimited,
  recordTaskOpen,
  isProjectDurationLocked,
  isScheduleLocked,
  isProjectLocked,
  PROJECT_LOCKED_TOAST,
  overrideDurationLock,
  overrideScheduleLock,
  clearLockOverrides,
  hasActiveLockOverride,
  useProjectLockState,
  type ProjectLockState
} from './useProjectLockGuard'
export { ProjectLockPopover } from './ProjectLockPopover'
export { ProjectLockScreen } from './ProjectLockScreen'
// Sharing (T-100): members, task visibility/grants, single-file shares.
export { MembersTab } from './sharing/MembersTab'
export { TaskSharingCard } from './sharing/TaskSharingCard'
export { ArtifactShareDialog } from './sharing/ArtifactShareDialog'
export { SharedWithMe } from './sharing/SharedWithMe'
export {
  ROLE_LABEL,
  useBoardRoles,
  useCanEdit,
  useIsTaskViewOnly,
  useDirectory,
  useMyRole,
  useSharingLiveUpdates,
  useSharingStatus,
  useRunsAgentsHere,
  type AccessRole
} from './sharing/useSharing'
