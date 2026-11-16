import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatComputerRequest } from './migration'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatFolderDeletions } from './hub-folders'
import { forEachIsolated } from '@slayzone/platform/isolation'
import { isComputerUnreachable, isolateItem } from './hub-isolation'

type State = 'active' | 'paused' | 'deleted'
interface Lifecycle {
  taskId: string
  state: State
  revision: number
}
/** Rebases one task may need in a delivery (one is enough unless the computer misbehaves). */
const MAX_REBASES = 3
/** Per-computer barrier. A failed delivery never becomes an acknowledgement. */
export function createChatLifecycle(opts: { db: SlayzoneDb; request: ChatComputerRequest }) {
  const { db } = opts,
    ownership = createChatOwnershipStore(db),
    pending = new Map<string, Promise<void>>(),
    /**
     * Per computer: tasks whose state the last pass could not deliver. Only that
     * task is fenced ({@link taskFailure}); every other task's commands proceed.
     * The next pass retries them.
     */
    failures = new Map<string, Map<string, { error: Error; stop: boolean }>>()
  async function deliverDeletions(computerId: string) {
    // Repair: older hubs re-marked removed chats pending (see deleteConversation).
    await db.run(
      `UPDATE chat_ownership SET cleanup_pending=0 WHERE state='deleted' AND cleanup_pending=1
        AND EXISTS(SELECT 1 FROM chat_deletion_targets d WHERE d.conversation_id=chat_ownership.id AND d.computer_id=?)
        AND NOT EXISTS(SELECT 1 FROM chat_deletion_targets d WHERE d.conversation_id=chat_ownership.id AND d.acknowledged=0)`,
      [computerId]
    )
    for (const target of await ownership.pendingDeletions(computerId))
      await isolateItem(`deletion of conversation ${target.conversationId}`, () =>
        deliverDeletion(computerId, target)
      )
  }
  async function deliverDeletion(
    computerId: string,
    target: { conversationId: string; epoch: number }
  ) {
    const owner = await ownership.get(target.conversationId)
    if (!owner || owner.state !== 'deleted') throw new Error('Deletion owner is unavailable')
    await opts.request(computerId, {
      kind: 'conversation.delete',
      identity: {
        id: owner.id,
        taskId: owner.taskId,
        tabId: owner.tabId,
        mode: owner.mode,
        epoch: target.epoch
      }
    })
    await ownership.acknowledgeDeletion(owner.id, computerId, target.epoch)
  }
  const unacknowledged = (computerId: string, stopsOnly: boolean) =>
    db.all<Lifecycle>(
      `SELECT l.task_id AS taskId,l.state,l.revision FROM chat_task_lifecycle l JOIN chat_task_computers c ON c.task_id=l.task_id LEFT JOIN chat_lifecycle_acks a ON a.task_id=l.task_id AND a.computer_id=c.computer_id WHERE c.computer_id=? AND COALESCE(a.revision,0)<l.revision${stopsOnly ? " AND l.state<>'active'" : ''} ORDER BY l.task_id`,
      [computerId]
    )
  async function deliver(computerId: string, rows: Lifecycle[]) {
    const failed = failures.get(computerId)!
    for (const row of rows)
      await isolateItem(
        `lifecycle of task ${row.taskId}`,
        () => deliverOne(computerId, row),
        (error) => failed.set(row.taskId, { error, stop: row.state !== 'active' })
      )
  }
  /**
   * Revisions are stamps, not proof: a computer can hold a revision this hub
   * never issued (the hub was restored from a backup). The hub is the authority,
   * so its state is re-issued at a revision past the computer's — a rebase,
   * never a fenced task. Bounded: a computer that keeps answering something else
   * fails only this task.
   */
  async function deliverOne(computerId: string, row: Lifecycle) {
    for (let rebases = 0; ; rebases++) {
      const reply = (await opts.request(computerId, { kind: 'task.lifecycle', ...row })) as {
        state: State
        revision: number
      }
      if (!reply || !Number.isSafeInteger(reply.revision) || reply.revision < 1)
        throw new Error('Invalid computer lifecycle acknowledgement')
      if (reply.state === 'deleted' && row.state !== 'deleted') {
        // A restored hub must honor a deletion already committed on the computer.
        await honorDeletion(row.taskId, reply.revision)
        return
      }
      if (reply.state === row.state && reply.revision === row.revision)
        return acknowledge(computerId, row.taskId, row.state, row.revision)
      if (reply.state === 'deleted') {
        // Deleted on both, the computer at a newer revision: one deletion.
        await raiseRevision(row.taskId, reply.revision)
        return acknowledge(computerId, row.taskId, 'deleted', reply.revision)
      }
      if (rebases >= MAX_REBASES)
        throw new Error('Computer task state did not converge with the hub')
      await raiseRevision(row.taskId, Math.max(row.revision, reply.revision) + 1)
      const current = await db.get<Lifecycle>(
        'SELECT task_id AS taskId,state,revision FROM chat_task_lifecycle WHERE task_id=?',
        [row.taskId]
      )
      if (!current) throw new Error('Task lifecycle is unavailable')
      row = current
    }
  }
  const raiseRevision = (taskId: string, revision: number) =>
    db.run('UPDATE chat_task_lifecycle SET revision=MAX(revision,?) WHERE task_id=?', [
      revision,
      taskId
    ])
  async function honorDeletion(taskId: string, revision: number) {
    await ownership.deleteForTask(taskId)
    await raiseRevision(taskId, revision)
  }
  async function acknowledge(computerId: string, taskId: string, state: State, revision: number) {
    await db.batchTxn([
      {
        type: 'run',
        sql: 'INSERT INTO chat_lifecycle_acks VALUES(?,?,?) ON CONFLICT(task_id,computer_id) DO UPDATE SET revision=MAX(chat_lifecycle_acks.revision,excluded.revision)',
        params: [taskId, computerId, revision]
      },
      ...(state === 'deleted'
        ? [
            {
              type: 'run' as const,
              sql: "UPDATE chat_deletion_targets SET acknowledged=1 WHERE computer_id=? AND conversation_id IN(SELECT id FROM chat_ownership WHERE task_id=? AND state='deleted')",
              params: [computerId, taskId]
            },
            {
              type: 'run' as const,
              sql: "UPDATE chat_ownership SET cleanup_pending=0 WHERE task_id=? AND state='deleted' AND NOT EXISTS(SELECT 1 FROM chat_deletion_targets d WHERE d.conversation_id=chat_ownership.id AND d.acknowledged=0)",
              params: [taskId]
            }
          ]
        : [])
    ])
  }
  /**
   * The lifecycle inventory: every task's state the computer holds, compared
   * with the hub's — including tasks without chats, which no chat inventory
   * reports. Run once per recovery pass, before delivery.
   * - Computer behind an acknowledgement (restored from a backup): the ack is
   *   dropped, so the hub's state is delivered again.
   * - Computer ahead of the hub (hub restored): the hub re-issues its state past
   *   the computer's revision (or honors a deletion the computer committed).
   * - A task the computer holds that the hub knows but does not route there is
   *   tracked, so its state is delivered there too.
   */
  async function reconcile(computerId: string) {
    const reported = (await opts.request(computerId, { kind: 'task.lifecycles' })) as Array<{
      taskId: string
      state: State
      revision: number
    }>
    if (!Array.isArray(reported)) throw new Error('Invalid computer lifecycle inventory')
    const onComputer = new Map(reported.map((l) => [l.taskId, l]))
    const tracked = await db.all<{ task_id: string }>(
      'SELECT task_id FROM chat_task_computers WHERE computer_id=?',
      [computerId]
    )
    const tasks = [...new Set([...tracked.map((t) => t.task_id), ...onComputer.keys()])].sort()
    const isTracked = new Set(tracked.map((t) => t.task_id))
    // One task whose state cannot be reconciled fails alone; an unreachable
    // computer fails the pass (no task could succeed).
    await forEachIsolated(
      tasks,
      {
        pass: 'chat.lifecycle-inventory',
        key: (taskId) => taskId,
        taskId: (taskId) => taskId,
        isFatal: isComputerUnreachable
      },
      async (taskId) => {
        const computer = onComputer.get(taskId) ?? { taskId, state: 'active', revision: 0 }
        if (
          typeof computer.taskId !== 'string' ||
          !['active', 'paused', 'deleted'].includes(computer.state) ||
          !Number.isSafeInteger(computer.revision) ||
          computer.revision < 0
        )
          throw new Error('Invalid computer lifecycle inventory entry')
        const hub = await db.get<Lifecycle>(
          'SELECT task_id AS taskId,state,revision FROM chat_task_lifecycle WHERE task_id=?',
          [taskId]
        )
        // Unknown to this hub (e.g. created after its backup): it stays only on
        // the computer, as chat recovery leaves it.
        if (!hub) return
        if (!isTracked.has(taskId)) await track(taskId, computerId)
        if (computer.state === 'deleted' && hub.state !== 'deleted')
          return honorDeletion(taskId, computer.revision)
        if (computer.state === hub.state && computer.revision === hub.revision)
          return acknowledge(computerId, taskId, hub.state, hub.revision)
        if (computer.revision >= hub.revision) {
          if (computer.state === 'deleted') {
            await raiseRevision(taskId, computer.revision)
            return acknowledge(computerId, taskId, 'deleted', computer.revision)
          }
          await raiseRevision(taskId, computer.revision + 1)
        }
        // Whatever the hub thinks it acknowledged beyond what the computer
        // holds is gone there: deliver it again.
        await db.run(
          'DELETE FROM chat_lifecycle_acks WHERE task_id=? AND computer_id=? AND revision>?',
          [taskId, computerId, computer.revision]
        )
      }
    )
  }
  async function track(taskId: string, computerId: string) {
    await db.run('INSERT OR IGNORE INTO chat_task_computers VALUES(?,?)', [taskId, computerId])
  }
  /** The task a chat request concerns, from a task id or a conversation route in it. */
  async function taskOfRequest(raw: unknown): Promise<string | null> {
    if (!raw || typeof raw !== 'object') return null
    const p = raw as Record<string, unknown>
    const value = (p.value && typeof p.value === 'object' ? p.value : {}) as Record<string, unknown>
    const field = (o: unknown, key: string) =>
      o && typeof o === 'object' && typeof (o as Record<string, unknown>)[key] === 'string'
        ? ((o as Record<string, unknown>)[key] as string)
        : null
    const task =
      field(p, 'taskId') ??
      field(p.identity, 'taskId') ??
      field(value, 'taskId') ??
      field(value.identity, 'taskId') ??
      field(value.to, 'taskId')
    if (task) return task
    const conversation = field(value.route, 'id') ?? field(p.route, 'id') ?? field(p, 'id')
    return conversation ? ((await ownership.get(conversation))?.taskId ?? null) : null
  }
  /** Unacknowledged rows, minus those this pass already failed to deliver. */
  async function remaining(computerId: string, stopsOnly: boolean) {
    const failed = failures.get(computerId)!
    return (await unacknowledged(computerId, stopsOnly)).filter((r) => !failed.has(r.taskId))
  }
  async function run(computerId: string) {
    failures.set(computerId, new Map())
    for (;;) {
      const rows = await remaining(computerId, false)
      if (!rows.length) {
        await deliverDeletions(computerId)
        await createChatFolderDeletions(db).sync(computerId, opts.request, (taskId, error) =>
          failures.get(computerId)!.set(taskId, { error, stop: false })
        )
        return
      }
      await deliver(computerId, rows)
    }
  }
  /**
   * The fence native commands (pty/proc/fs/git) wait on: only pending pause or
   * delete, which stop the task's native work on the computer. Reactivation,
   * conversation and artifact-folder deletions are chat-store state; a computer
   * whose chat store cannot apply them must still run terminals, files and git.
   */
  async function runNative(computerId: string) {
    if (!failures.has(computerId)) failures.set(computerId, new Map())
    for (;;) {
      const rows = await remaining(computerId, true)
      if (!rows.length) return
      await deliver(computerId, rows)
    }
  }
  const nativePending = new Map<string, Promise<void>>()
  function syncNative(computerId: string) {
    const existing = nativePending.get(computerId)
    if (existing) return existing
    const work = runNative(computerId).finally(() => {
      nativePending.delete(computerId)
    })
    nativePending.set(computerId, work)
    return work
  }
  function sync(computerId: string) {
    const existing = pending.get(computerId)
    if (existing) return existing
    const work = run(computerId).finally(() => {
      pending.delete(computerId)
    })
    pending.set(computerId, work)
    return work
  }
  return {
    sync,
    syncNative,
    /**
     * Why the last pass could not deliver this task's state, if it could not.
     * `stopsOnly`: only an undelivered pause or delete (the fence for the task's
     * native work); reactivation and folder deletions are chat-store state.
     */
    taskFailure(computerId: string, taskId: string, stopsOnly = false): Error | undefined {
      const failure = failures.get(computerId)?.get(taskId)
      return failure && (!stopsOnly || failure.stop) ? failure.error : undefined
    },
    track,
    reconcile,
    async syncTask(taskId: string) {
      const targets = await db.all<{ computer_id: string }>(
        'SELECT computer_id FROM chat_task_computers WHERE task_id=?',
        [taskId]
      )
      await Promise.all(targets.map((t) => sync(t.computer_id)))
    },
    /**
     * The barrier: a command reaches the computer only after its task's pending
     * pause/delete and folder deletions did. A task whose delivery failed has
     * its own commands refused; other tasks' commands proceed.
     */
    async request(computerId: string, request: unknown) {
      await sync(computerId)
      const failed = failures.get(computerId)
      if (failed?.size) {
        const taskId = await taskOfRequest(request)
        const failure = taskId ? failed.get(taskId)?.error : undefined
        if (failure)
          throw new Error(
            `This task's state could not be delivered to its computer: ${failure.message}`,
            { cause: failure }
          )
      }
      return opts.request(computerId, request)
    }
  }
}
