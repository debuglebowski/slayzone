import { lazy } from 'react'

// Lazy-loaded heavy panels — split out of TaskDetailPage so each panel chunk loads on demand.
export const ArtifactsPanel = lazy(() =>
  import('@slayzone/task-artifacts/client').then((m) => ({ default: m.ArtifactsPanel }))
)
export const DescriptionDialog = lazy(() =>
  import('../DescriptionDialog').then((m) => ({ default: m.DescriptionDialog }))
)
export const RichTextEditor = lazy(() =>
  import('@slayzone/editor').then((m) => ({ default: m.RichTextEditor }))
)
export const UnifiedGitPanel = lazy(() =>
  import('@slayzone/worktrees').then((m) => ({ default: m.UnifiedGitPanel }))
)
export const BrowserPanel = lazy(() =>
  import('@slayzone/task-browser').then((m) => ({ default: m.BrowserPanel }))
)
export const FileEditorView = lazy(() =>
  import('@slayzone/file-editor/client').then((m) => ({ default: m.FileEditorView }))
)
