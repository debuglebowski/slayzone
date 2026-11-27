import { ProcessesPanel } from '../../ProcessesPanel'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/** The task's processes (`processes`). */
export function ProcessesKind({ panelId }: PanelKindProps): React.JSX.Element {
  const { task, project, mainAgentCwd, openDevServerInBrowser, getMainSessionId, processes } =
    useTaskPageContext()
  return (
    <PanelFrame kind="processes" panelId={panelId} className="overflow-hidden flex flex-col">
      <ProcessesPanel
        taskId={task.id}
        projectId={project?.id ?? null}
        cwd={mainAgentCwd}
        cwdUnavailable={processes.processesCwdUnavailable}
        terminalSessionId={getMainSessionId(task.id)}
        onOpenUrl={openDevServerInBrowser}
      />
    </PanelFrame>
  )
}
