import { FileEditorView } from '../../task-detail/lazyPanels'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/** The file editor over the task's repo (`editor`). Empty while it has no repo path. */
export function EditorKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, effectiveRepoPath, openDevServerInBrowser, editor } = useTaskPageContext()
  const { fileEditorRefCallback, handleEditorStateChange } = editor
  return (
    <PanelFrame kind="editor" panelId={panelId} className="overflow-hidden">
      {effectiveRepoPath ? (
        <FileEditorView
          ref={fileEditorRefCallback}
          projectPath={effectiveRepoPath}
          // Read and write the SAME filesystem the task's agents
          // work in. Without this the panel reads the hub's disk,
          // so a remote task's editor shows files no agent can see
          // and a save lands where nothing is running.
          target={{ taskId: task.id }}
          initialEditorState={task.editor_open_files}
          onEditorStateChange={handleEditorStateChange}
          onOpenUrl={openDevServerInBrowser}
        />
      ) : null}
    </PanelFrame>
  )
}
