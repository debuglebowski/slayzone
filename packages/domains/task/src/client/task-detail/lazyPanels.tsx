import { lazyWithPreload } from '@slayzone/ui'
import { browserTaskSource } from './browserTaskSource'

// Lazy-loaded heavy panels — split out of TaskDetailPage so each panel chunk loads on demand.
// Artifacts + git panels are injected by the app (see TaskPanels.tsx).
export const DescriptionDialog = lazyWithPreload(() =>
  import('../DescriptionDialog').then((m) => ({ default: m.DescriptionDialog }))
)
export const RichTextEditor = lazyWithPreload(() =>
  import('@slayzone/editor').then((m) => ({ default: m.RichTextEditor }))
)
// task supplies the browser panel's task data/writes (task-browser can't call
// task.* itself: task sits above it). Registered as the module loads, so it is
// in place before the panel's first render.
export const BrowserPanel = lazyWithPreload(() =>
  import('@slayzone/task-browser').then((m) => {
    m.registerBrowserTaskSource(browserTaskSource)
    return { default: m.BrowserPanel }
  })
)
export const FileEditorView = lazyWithPreload(() =>
  import('@slayzone/file-editor/client').then((m) => ({ default: m.FileEditorView }))
)
