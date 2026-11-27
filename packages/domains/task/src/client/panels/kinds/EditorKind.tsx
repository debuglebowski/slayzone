import { PRIMARY_INSTANCE_IDS } from '@slayzone/task-contracts'
import type { EditorOpenFilesState } from '@slayzone/file-editor/shared'
import { FileEditorView } from '../../task-detail/lazyPanels'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * The file editor over the task's repo (`editor`, or another editor instance, whose
 * open files live in `panel_instance_state`). Empty while the task has no repo path.
 */
export function EditorKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, effectiveRepoPath, openDevServerInBrowser, panels, editor } = useTaskPageContext()
  const { editorHandles, handleEditorStateChange } = editor
  const primary = panelId === PRIMARY_INSTANCE_IDS.editor
  const saved = primary
    ? task.editor_open_files
    : ((panels.instanceState.get(panelId).editorOpenFiles as EditorOpenFilesState | undefined) ??
      null)
  return (
    <PanelFrame kind="editor" panelId={panelId} className="overflow-hidden">
      {effectiveRepoPath ? (
        <FileEditorView
          ref={editorHandles.ref(panelId)}
          projectPath={effectiveRepoPath}
          // Read and write the SAME filesystem the task's agents
          // work in. Without this the panel reads the hub's disk,
          // so a remote task's editor shows files no agent can see
          // and a save lands where nothing is running.
          target={{ taskId: task.id }}
          initialEditorState={saved}
          onEditorStateChange={
            primary
              ? handleEditorStateChange
              : (state) => panels.instanceState.patch(panelId, { editorOpenFiles: state })
          }
          onOpenUrl={openDevServerInBrowser}
        />
      ) : null}
    </PanelFrame>
  )
}
