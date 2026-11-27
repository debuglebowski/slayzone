import { create } from 'zustand'
import type { CreateTaskDraft } from '@slayzone/task-contracts'
import type { Task } from '@slayzone/task-contracts'
import type { Project, ProjectGroup } from '@slayzone/projects-contracts'

export interface SearchFileContext {
  /**
   * Whose files: the search runs on the computer that holds them — the task's
   * computer for a task, the project's for the project view.
   */
  target: { taskId: string } | { projectId: string }
  projectPath: string
  openFile: (path: string) => void
}

interface DialogState {
  // Create task
  createTaskOpen: boolean
  createTaskDraft: CreateTaskDraft
  openCreateTask: (draft?: CreateTaskDraft) => void
  closeCreateTask: () => void

  // Edit task
  editingTask: Task | null
  openEditTask: (task: Task) => void
  closeEditTask: () => void

  // Delete task
  deletingTask: Task | null
  openDeleteTask: (task: Task) => void
  closeDeleteTask: () => void

  // Create project
  createProjectOpen: boolean
  /** The hub the dialog opens on (a hub's Settings → Projects); null = the default hub. */
  createProjectHubId: string | null
  openCreateProject: (hubId?: string | null) => void
  closeCreateProject: () => void

  // Delete project
  deletingProject: Project | null
  openDeleteProject: (project: Project) => void
  closeDeleteProject: () => void

  // Move a project to another hub
  projectTransferMode: 'move' | 'copy'
  movingProjectToHub: Project | null
  openMoveProjectToHub: (project: Project, mode?: 'move' | 'copy') => void
  closeMoveProjectToHub: () => void

  relocatingProject: Project | null
  openRelocateProject: (project: Project) => void
  closeRelocateProject: () => void

  // Project-group (folder) settings
  groupSettingsTarget: ProjectGroup | null
  openGroupSettings: (group: ProjectGroup) => void
  closeGroupSettings: () => void

  // Simple booleans
  onboardingOpen: boolean
  openOnboarding: () => void
  closeOnboarding: () => void

  changelogOpen: boolean
  openChangelog: () => void
  closeChangelog: () => void

  searchOpen: boolean
  searchFileContext: SearchFileContext | null
  openSearch: (payload?: { fileContext?: SearchFileContext }) => void
  closeSearch: () => void

  completeTaskDialogOpen: boolean
  openCompleteTaskDialog: () => void
  closeCompleteTaskDialog: () => void

  showAnimatedTour: boolean
  openAnimatedTour: () => void
  closeAnimatedTour: () => void

  terminalsOpen: boolean
  openTerminals: () => void
  closeTerminals: () => void
}

export const useDialogStore = create<DialogState>()((set) => ({
  createTaskOpen: false,
  createTaskDraft: {},
  openCreateTask: (draft) => set({ createTaskOpen: true, createTaskDraft: draft ?? {} }),
  closeCreateTask: () => set({ createTaskOpen: false, createTaskDraft: {} }),

  editingTask: null,
  openEditTask: (task) => set({ editingTask: task }),
  closeEditTask: () => set({ editingTask: null }),

  deletingTask: null,
  openDeleteTask: (task) => set({ deletingTask: task }),
  closeDeleteTask: () => set({ deletingTask: null }),

  createProjectOpen: false,
  createProjectHubId: null,
  openCreateProject: (hubId = null) => set({ createProjectOpen: true, createProjectHubId: hubId }),
  closeCreateProject: () => set({ createProjectOpen: false, createProjectHubId: null }),

  deletingProject: null,
  openDeleteProject: (project) => set({ deletingProject: project }),
  closeDeleteProject: () => set({ deletingProject: null }),

  projectTransferMode: 'move',
  movingProjectToHub: null,
  openMoveProjectToHub: (project, mode = 'move') =>
    set({ movingProjectToHub: project, projectTransferMode: mode }),
  closeMoveProjectToHub: () => set({ movingProjectToHub: null }),

  relocatingProject: null,
  openRelocateProject: (project) => set({ relocatingProject: project }),
  closeRelocateProject: () => set({ relocatingProject: null }),

  groupSettingsTarget: null,
  openGroupSettings: (group) => set({ groupSettingsTarget: group }),
  closeGroupSettings: () => set({ groupSettingsTarget: null }),

  onboardingOpen: false,
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),

  changelogOpen: false,
  openChangelog: () => set({ changelogOpen: true }),
  closeChangelog: () => set({ changelogOpen: false }),

  searchOpen: false,
  searchFileContext: null,
  openSearch: (payload) =>
    set({ searchOpen: true, searchFileContext: payload?.fileContext ?? null }),
  closeSearch: () => set({ searchOpen: false, searchFileContext: null }),

  completeTaskDialogOpen: false,
  openCompleteTaskDialog: () => set({ completeTaskDialogOpen: true }),
  closeCompleteTaskDialog: () => set({ completeTaskDialogOpen: false }),

  showAnimatedTour: false,
  openAnimatedTour: () => set({ showAnimatedTour: true }),
  closeAnimatedTour: () => set({ showAnimatedTour: false }),

  terminalsOpen: false,
  openTerminals: () => set({ terminalsOpen: true }),
  closeTerminals: () => set({ terminalsOpen: false })
}))
