import { lazyWithPreload } from '@slayzone/ui'

// Lazy-loaded heavy panels — split out of TaskDetailPage so each panel chunk loads on demand.
export const ArtifactsPanel = lazyWithPreload(() =>
  import('@slayzone/task-artifacts/client').then((m) => ({ default: m.ArtifactsPanel }))
)
export const DescriptionDialog = lazyWithPreload(() =>
  import('../DescriptionDialog').then((m) => ({ default: m.DescriptionDialog }))
)
export const RichTextEditor = lazyWithPreload(() =>
  import('@slayzone/editor').then((m) => ({ default: m.RichTextEditor }))
)
export const UnifiedGitPanel = lazyWithPreload(() =>
  import('@slayzone/worktrees').then((m) => ({ default: m.UnifiedGitPanel }))
)
export const BrowserPanel = lazyWithPreload(() =>
  import('@slayzone/task-browser').then((m) => ({ default: m.BrowserPanel }))
)
export const FileEditorView = lazyWithPreload(() =>
  import('@slayzone/file-editor/client').then((m) => ({ default: m.FileEditorView }))
)
