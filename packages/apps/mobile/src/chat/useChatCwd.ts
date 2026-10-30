/**
 * The folder of a chat tab (see `chat-cwd.ts` for why it must be exact): the tab's
 * session folder on the hub (`chat.getInfo`), else the folder desktop would start the
 * task in — from `task.get`, `projects.list` and, only when a bound child repo decides
 * it, `worktrees.detectChildRepos` (run on the task's computer, as the hub's
 * `task.startMainAgent` does). Settled once: a later change of the task's folder never
 * moves an open chat.
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { chatCwdFromSession, chatCwdFromTask, chosenFolder } from './chat-cwd'
import { useTRPC } from '../trpc'

export type ChatCwdState =
  | { status: 'loading' }
  | { status: 'ready'; cwd: string }
  /**
   * The task has no folder to run in (no project folder, no base dir). `notFound`: the
   * folder chosen on its computer, which is gone.
   */
  | { status: 'none'; notFound: string | null }
  | { status: 'error'; message: string; retry: () => void }

export function useChatCwd(taskId: string, tabId: string): ChatCwdState {
  const trpc = useTRPC()
  const infoQ = useQuery(trpc.chat.getInfo.queryOptions({ tabId }))
  const sessionCwd = infoQ.isSuccess ? chatCwdFromSession(infoQ.data, taskId) : null
  const needTask = infoQ.isSuccess && sessionCwd === null
  const taskQ = useQuery(trpc.task.get.queryOptions({ id: taskId }, { enabled: needTask }))
  const projectsQ = useQuery(trpc.projects.list.queryOptions(undefined, { enabled: needTask }))

  const task = taskQ.data ?? null
  const project = task ? (projectsQ.data?.find((p) => p.id === task.project_id) ?? null) : null
  const first = task && projectsQ.isSuccess ? chatCwdFromTask(task, project, null) : null
  const projectPath = first && 'needsRepos' in first ? first.needsRepos : null
  const reposQ = useQuery(
    trpc.worktrees.detectChildRepos.queryOptions(
      { projectPath: projectPath ?? '', taskId },
      { enabled: projectPath !== null }
    )
  )

  const none: ChatCwdState = { status: 'none', notFound: task ? chosenFolder(task, project) : null }
  let computed: ChatCwdState = { status: 'loading' }
  if (sessionCwd !== null) computed = { status: 'ready', cwd: sessionCwd }
  else if (first && 'cwd' in first) {
    computed = first.cwd ? { status: 'ready', cwd: first.cwd } : none
  } else if (first && reposQ.isSuccess && task) {
    const resolved = chatCwdFromTask(task, project, reposQ.data)
    if ('cwd' in resolved) {
      computed = resolved.cwd ? { status: 'ready', cwd: resolved.cwd } : none
    }
  } else if (needTask && taskQ.isSuccess && task === null) {
    computed = {
      status: 'error',
      message: 'This task no longer exists.',
      retry: () => void taskQ.refetch()
    }
  }
  const failed = [infoQ, taskQ, projectsQ, reposQ].find((q) => q.isError)
  if (computed.status === 'loading' && failed) {
    computed = {
      status: 'error',
      message: failed.error?.message ?? 'Could not load the chat',
      retry: () => {
        for (const q of [infoQ, taskQ, projectsQ, reposQ]) if (q.isError) void q.refetch()
      }
    }
  }

  // Settled once (React's "adjust state when a value changes" pattern, during render).
  const [settled, setSettled] = useState<string | null>(null)
  if (settled === null && computed.status === 'ready') setSettled(computed.cwd)
  return settled !== null ? { status: 'ready', cwd: settled } : computed
}
