import type { ComponentProps } from 'react'
import { TaskContextMenu } from '@slayzone/tasks/hooks'
import { useTaskTerminalState } from '@slayzone/terminal/client'

type SidebarTaskContextMenuProps = Omit<ComponentProps<typeof TaskContextMenu>, 'canMarkUnread'>

/**
 * The sidebar tree's task context menu. "Mark as unread" is offered once the task's
 * agent is idle and the task is read — subscribed here, so the item follows the
 * agent's state instead of whenever the row last happened to re-render.
 */
export function SidebarTaskContextMenu(props: SidebarTaskContextMenuProps): React.JSX.Element {
  const agentIdle = useTaskTerminalState(props.task.id) === 'idle'
  return <TaskContextMenu {...props} canMarkUnread={agentIdle && !props.task.needs_attention} />
}
