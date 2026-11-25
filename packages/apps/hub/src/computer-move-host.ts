/** Host adapters for task-owned computer moves. All paths and bytes stay on computers. */
import type { SlayzoneDb } from '@slayzone/platform'
import { forEachIsolated } from '@slayzone/platform/isolation'
import { runInPathScope } from '@slayzone/platform/path-scope'
import { getComputer } from '@slayzone/computers/server'
import {
  HubToComputerMethods,
  workspaceManifestSchema,
  type WorkspaceMoveInspection
} from '@slayzone/computer-transport/shared'
import type { HubComputerGateway } from '@slayzone/computer-transport/server'
import {
  createComputerMoves,
  resetConversation,
  setComputerMoves,
  stageComputerMoveSessions,
  taskMoveSessionsOrNull,
  type ComputerMoveHost
} from '@slayzone/task/server'
import type { ComputerMove, ComputerMoveDestination } from '@slayzone/task-contracts'
import { DEFAULT_AGENTS } from '@slayzone/terminal-contracts'
import type { ComputerPlacement } from './computer-placement'

export function installComputerMoves(opts: {
  db: SlayzoneDb
  gateway(): HubComputerGateway | null
  placement: ComputerPlacement
  revoke(taskId: string): Promise<void>
  changed(taskId: string): void
}) {
  const gateway = () => {
    const g = opts.gateway()
    if (!g) throw new Error('Computers are still connecting')
    return g
  }
  const call = async <T>(
    computerId: string,
    taskId: string,
    projectId: string,
    input: object
  ): Promise<T> => {
    await opts.placement.gate?.(computerId, { kind: 'task', id: taskId })
    return runInPathScope({ kind: 'task', taskId, projectId }, () =>
      gateway().request<T>(
        computerId,
        HubToComputerMethods.workspaceMove,
        {
          taskId,
          projectId,
          ...input
        },
        [
          'snapshot',
          'begin',
          'verify',
          'verifySource',
          'verifyDestination',
          'activate',
          'discard',
          'clone'
        ].includes((input as { op?: string }).op ?? '')
          ? 30 * 60 * 1000
          : undefined
      )
    )
  }
  const request = <T>(m: ComputerMove, side: 'source' | 'target', input: object) =>
    call<T>(
      side === 'source' ? m.sourceComputerId : m.destinationComputerId,
      m.taskId,
      m.projectId,
      { id: m.id, ...input }
    )
  const release = async (m: ComputerMove, computerId: string) => {
    await call(computerId, m.taskId, m.projectId, { op: 'unlock', id: m.id })
    await call(computerId, m.taskId, m.projectId, { op: 'discard', id: m.id })
    await gateway().request(computerId, HubToComputerMethods.chatRequest, {
      kind: 'sessionMove.discard',
      moveId: m.id
    })
  }
  const authoritativeHolders = async (taskId: string): Promise<string[]> => {
    const tracked = (await taskMoveSessionsOrNull()?.holders(taskId)) ?? []
    const owners = await opts.db.all<{ computer_id: string }>(
      "SELECT DISTINCT computer_id FROM chat_ownership WHERE task_id=? AND state<>'deleted' AND computer_id IS NOT NULL",
      [taskId]
    )
    const active = new Set(owners.map((r) => r.computer_id))
    const finished = await opts.db.all<{ value: string }>(
      "SELECT value FROM task_computer_moves WHERE task_id=? AND status IN ('done','canceled')",
      [taskId]
    )
    const backups = new Set<string>()
    for (const row of finished) {
      const old: ComputerMove = JSON.parse(row.value)
      if (old.status === 'canceled') backups.add(old.destinationComputerId)
      else
        for (const id of old.participants ?? [old.sourceComputerId])
          if (id !== old.destinationComputerId) backups.add(id)
    }
    return [...new Set([...tracked, ...active])].filter((id) => !backups.has(id) || active.has(id))
  }
  const host: ComputerMoveHost = {
    resolve: async (taskId) =>
      (await opts.placement.forTask(taskId)) ?? (await authoritativeHolders(taskId))[0] ?? null,
    destination: async (taskId, binding) => {
      if (binding) {
        await opts.placement.gate?.(binding, { kind: 'task', id: taskId })
        return binding
      }
      const row = await opts.db.get<{ project_id: string; repo_name: string | null }>(
        'SELECT project_id,repo_name FROM tasks WHERE id=?',
        [taskId]
      )
      return row ? opts.placement.forProject(row.project_id) : null
    },
    async inspect(taskId, source, target) {
      const blockers: string[] = []
      const row = await opts.db.get<{ project_id: string; repo_name: string | null }>(
        'SELECT project_id,repo_name FROM tasks WHERE id=?',
        [taskId]
      )
      if (!row) throw new Error('Task no longer exists')
      const participants = [...new Set([source, target, ...(await authoritativeHolders(taskId))])]
      for (const id of participants) {
        const computer = await getComputer(opts.db, id)
        if (
          !computer ||
          computer.revoked_at != null ||
          (id === target && computer.disabled_at != null)
        )
          blockers.push(`${computer?.name ?? 'Computer'} is unavailable or disabled.`)
        else if (
          !gateway()
            .listUsableComputers()
            .some((c) => c.computerId === id)
        )
          blockers.push(`${computer.name} must be online to move this task.`)
      }
      const tabs = await opts.db.all<{
        id: string
        mode: string
        label: string | null
        initial_command: string | null
      }>(
        "SELECT t.id,t.mode,t.label,a.initial_command FROM terminal_tabs t LEFT JOIN agents a ON a.id=t.mode WHERE t.task_id=? AND t.mode<>'terminal'",
        [taskId]
      )
      const program = (tab: (typeof tabs)[number]) => {
        const definition = DEFAULT_AGENTS.find((a) => a.id === tab.mode)
        const command =
          tab.initial_command ??
          definition?.initialCommand ??
          DEFAULT_AGENTS.find((a) => a.type === definition?.type && a.initialCommand)
            ?.initialCommand
        return (
          command
            ?.trim()
            .match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
            ?.slice(1)
            .find(Boolean) ?? null
        )
      }
      const commands = [
        ...new Set(tabs.map(program).filter((command): command is string => command !== null))
      ]
      let installed: Record<string, boolean> = {}
      let sessionModes: string[] | null = null
      let hasRunningWork = false
      let destination: ComputerMoveDestination | null = null
      if (!blockers.length) {
        try {
          const inspected = await call<WorkspaceMoveInspection>(target, taskId, row.project_id, {
            op: 'inspect',
            repoName: row.repo_name,
            commands
          })
          if (!inspected.projectReady)
            blockers.push(
              inspected.folder
                ? `This project’s folder ${inspected.folder} does not exist on the destination computer.`
                : 'Choose this project’s folder on the destination computer first.'
            )
          installed = { ...inspected.agents, ...inspected.commands }
          sessionModes = []
          let repoRequired = false
          let cloneUrl: string | null = null
          for (const computerId of participants) {
            const sourceState = await call<WorkspaceMoveInspection>(
              computerId,
              taskId,
              row.project_id,
              { op: 'inspect', repoName: row.repo_name }
            )
            sessionModes.push(...sourceState.sessionModes)
            hasRunningWork ||= sourceState.hasWork
            if (computerId === source) {
              repoRequired = sourceState.worktreeGit
              cloneUrl = sourceState.remoteUrl
              if (sourceState.worktreeGit && !inspected.repoReady && inspected.projectReady)
                blockers.push(
                  'The task’s repository must be checked out in this project’s destination folder first.'
                )
            }
          }
          destination = {
            folder: inspected.folder,
            folderExists: inspected.projectReady,
            repoPath: inspected.repoPath,
            repoRequired,
            repoReady: inspected.repoReady,
            cloneUrl
          }
        } catch (error) {
          blockers.push(
            `Destination cannot accept migrations: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      const agents = tabs
        .filter((tab) => sessionModes === null || sessionModes.includes(tab.mode))
        .map((tab) => {
          const cli = program(tab)
          if (cli && !installed[cli] && !blockers.length)
            blockers.push(`Install ${cli} on the destination computer first.`)
          const canResume = ['claude-code', 'claude-chat', 'codex-chat'].includes(tab.mode)
          return {
            tabId: tab.id,
            label: tab.label ?? tab.mode,
            canResume,
            ...(!canResume
              ? { reason: 'This agent’s session cannot resume automatically on another computer.' }
              : {})
          }
        })
      return {
        ready: blockers.length === 0,
        blockers,
        agents,
        hasRunningWork,
        hasStoredSessions: (sessionModes?.length ?? 0) > 0,
        participants,
        destination
      }
    },
    async cloneRepository(taskId, source, target) {
      const row = await opts.db.get<{ project_id: string; repo_name: string | null }>(
        'SELECT project_id,repo_name FROM tasks WHERE id=?',
        [taskId]
      )
      if (!row) throw new Error('Task no longer exists')
      const origin = await call<WorkspaceMoveInspection>(source, taskId, row.project_id, {
        op: 'inspect',
        repoName: row.repo_name
      })
      if (!origin.remoteUrl) throw new Error('The source repository has no remote to clone from.')
      await call(target, taskId, row.project_id, {
        op: 'clone',
        repoName: row.repo_name,
        url: origin.remoteUrl
      })
    },
    async stop(m) {
      await opts.revoke(m.taskId)
      for (const id of m.participants)
        await call(id, m.taskId, m.projectId, { op: 'lock', id: m.id })
    },
    async copyWorkspace(m, progress) {
      const manifest = workspaceManifestSchema.parse(await request(m, 'source', { op: 'snapshot' }))
      if (
        manifest.roots.some((r) => r.key === 'worktree') !== (m.sourceState.hasWorktree === 1) ||
        manifest.roots.some((r) => r.key === 'base') !== (m.sourceState.hasBaseDir === 1)
      )
        throw new Error(
          'The source computer’s task folders do not match the task’s folder bindings. Restore the missing folder binding before migrating.'
        )
      if (m.sourceComputerId === m.destinationComputerId) return
      await request(m, 'target', { op: 'begin', manifest })
      let done = 0
      let lastProgress = Date.now()
      if (Date.now() - lastProgress >= 250 || done === manifest.totalBytes) {
        await progress(done, manifest.totalBytes)
        lastProgress = Date.now()
      }
      for (const file of manifest.entries)
        if (file.type === 'file') {
          let offset = await request<number>(m, 'target', { op: 'offset', path: file.path })
          done += offset
          do {
            const data = await request<string>(m, 'source', {
              op: 'read',
              path: file.path,
              offset,
              length: 256 * 1024
            })
            if (!data && offset < file.size)
              throw new Error(`Workspace export ended early: ${file.path}`)
            const next = await request<number>(m, 'target', {
              op: 'write',
              path: file.path,
              offset,
              data
            })
            if (next < offset || (next === offset && offset < file.size))
              throw new Error('Workspace transfer made no progress')
            done += next - offset
            offset = next
            await progress(done, manifest.totalBytes)
          } while (offset < file.size)
        }
      await request(m, 'target', { op: 'verify' })
    },
    copySessions: stageComputerMoveSessions,
    verifySource: async (m) => {
      await request(m, 'source', { op: 'verifySource' })
      if (m.sourceComputerId !== m.destinationComputerId)
        await request(m, 'target', { op: 'verifyDestination' })
    },
    activate: async (m) => {
      if (m.sourceComputerId === m.destinationComputerId) return
      const task = await opts.db.get<{ repo_name: string | null }>(
        'SELECT repo_name FROM tasks WHERE id=?',
        [m.taskId]
      )
      await request(m, 'target', { op: 'activate', repoName: task?.repo_name ?? null })
    },
    async cancel(m) {
      // Destination is never routed to before commit. Keep any completed folder
      // copy as a recovery copy; no user-owned source or destination code is deleted.
      await Promise.allSettled(m.participants.map((id) => release(m, id)))
    },
    async finish(m) {
      for (const tabId of m.freshTabIds)
        await resetConversation(opts.db, { taskId: m.taskId, scope: { tabId } })
      await taskMoveSessionsOrNull()?.settle(m.destinationComputerId)
      await release(m, m.destinationComputerId)
      // Source may disconnect after the commit. Its durable local lock stays
      // until reconnect cleanup, while verified destination work can proceed.
      for (const id of m.participants.filter((id) => id !== m.destinationComputerId))
        await release(m, id).catch(() => undefined)
    },
    changed: opts.changed
  }
  const moves = createComputerMoves(opts.db, host)
  setComputerMoves(moves)
  return {
    ...moves,
    async recover() {
      const rows = await opts.db.all<{ id: string; value: string }>(
        'SELECT id, value FROM task_computer_moves'
      )
      // One unreadable journal row never keeps the other moves from recovering.
      await forEachIsolated(
        rows,
        { pass: 'hub.computer-move-recovery', key: (row) => row.id },
        async (row) => {
          const m: ComputerMove = JSON.parse(row.value)
          const usable = new Set(
            gateway()
              .listUsableComputers()
              .map((c) => c.computerId)
          )
          if (m.status === 'canceled' || m.status === 'done') {
            const held = (m.participants ?? [m.sourceComputerId, m.destinationComputerId]).filter(
              (id) => usable.has(id)
            )
            // Each release is best-effort and independent: a failed one is retried on the
            // next reconnect.
            await Promise.all(held.map((id) => release(m, id).catch(() => undefined)))
          } else if (
            m.status === 'running' &&
            usable.has(m.destinationComputerId) &&
            (m.step === 'finish' || usable.has(m.sourceComputerId))
          )
            void moves
              .run(m.taskId)
              .catch((error: unknown) => console.error('[computer-move] recovery:', error))
        }
      )
    }
  }
}
