import { lazy, type LazyExoticComponent } from 'react'
// Props type isn't exported from the file-editor barrel, so once `FileEditorView`
// is an *exported* binding TS can't name it for declaration emit (TS4023). The
// `import type` (erased at runtime) gives an explicit, nameable annotation.
import type { FileEditorView as FileEditorViewComponent } from '@slayzone/file-editor/client/FileEditorView'

// Lazy-loaded home panels — one chunk + Suspense identity shared by every
// consumer (the Electron app and the Chromium fork). Mirrors the app-shell
// loaders so behaviour is identical.
export const KanbanBoard = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanBoard }))
)
export const KanbanListView = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.KanbanListView }))
)
export const FilterBar = lazy(() =>
  import('@slayzone/tasks').then((m) => ({ default: m.FilterBar }))
)
export const UnifiedGitPanel = lazy(() =>
  import('@slayzone/worktrees').then((m) => ({ default: m.UnifiedGitPanel }))
)
export const FileEditorView: LazyExoticComponent<typeof FileEditorViewComponent> = lazy(() =>
  import('@slayzone/file-editor/client/FileEditorView').then((m) => ({ default: m.FileEditorView }))
)
export const ProcessesPanel = lazy(() =>
  import('@slayzone/task').then((m) => ({ default: m.ProcessesPanel }))
)
export const TestPanel = lazy(() =>
  import('@slayzone/test-panel').then((m) => ({ default: m.TestPanel }))
)
export const AutomationsPanel = lazy(() =>
  import('@slayzone/automations').then((m) => ({ default: m.AutomationsPanel }))
)
