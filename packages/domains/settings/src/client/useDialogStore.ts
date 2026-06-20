import { create } from 'zustand'
import type { CreateTaskDraft } from '@slayzone/task/shared'
import type { Task } from '@slayzone/task/shared'
import type { Project, ProjectGroup } from '@slayzone/projects/shared'

export interface SearchFileContext {
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
  openCreateProject: () => void
  closeCreateProject: () => void

  // Delete project
  deletingProject: Project | null
  openDeleteProject: (project: Project) => void
  closeDeleteProject: () => void

  // Project-group (folder) settings
  groupSettingsTarget: ProjectGroup | null
  openGroupSettings: (group: ProjectGroup) => void
  closeGroupSettings: () => void

  // Per-project settings dialog target + open context. initialTab /
  // onboardingProvider let an opener deep-link straight to a tab (e.g. the
  // create-with-GitHub flow lands on Integrations). Typed loosely (string) so
  // the store doesn't couple to the projects/integrations client types — the
  // consumer casts to the dialog's prop union at the boundary.
  projectSettingsTarget: Project | null
  projectSettingsInitialTab: string | null
  projectSettingsOnboardingProvider: string | null
  openProjectSettings: (
    project: Project,
    opts?: { initialTab?: string; integrationOnboardingProvider?: string | null }
  ) => void
  closeProjectSettings: () => void

  // App-level (user) settings dialog. Canonical App.tsx still drives this via
  // local useState; the store field is the convergence target so the
  // chromium-fork shell + its AppDialogs share one store-driven source. Additive
  // — the Electron app ignores these fields today.
  settingsOpen: boolean
  settingsInitialTab: string | null
  openSettings: (opts?: { initialTab?: string }) => void
  closeSettings: () => void

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
  openCreateProject: () => set({ createProjectOpen: true }),
  closeCreateProject: () => set({ createProjectOpen: false }),

  deletingProject: null,
  openDeleteProject: (project) => set({ deletingProject: project }),
  closeDeleteProject: () => set({ deletingProject: null }),

  groupSettingsTarget: null,
  openGroupSettings: (group) => set({ groupSettingsTarget: group }),
  closeGroupSettings: () => set({ groupSettingsTarget: null }),

  projectSettingsTarget: null,
  projectSettingsInitialTab: null,
  projectSettingsOnboardingProvider: null,
  openProjectSettings: (project, opts) =>
    set({
      projectSettingsTarget: project,
      projectSettingsInitialTab: opts?.initialTab ?? null,
      projectSettingsOnboardingProvider: opts?.integrationOnboardingProvider ?? null
    }),
  closeProjectSettings: () =>
    set({
      projectSettingsTarget: null,
      projectSettingsInitialTab: null,
      projectSettingsOnboardingProvider: null
    }),

  settingsOpen: false,
  settingsInitialTab: null,
  openSettings: (opts) =>
    set({ settingsOpen: true, settingsInitialTab: opts?.initialTab ?? null }),
  closeSettings: () => set({ settingsOpen: false, settingsInitialTab: null }),

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
