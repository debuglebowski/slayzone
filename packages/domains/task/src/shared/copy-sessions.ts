import type {
  TaskMove,
  TaskMoveAttachmentRef,
  TaskMoveChatTransfer,
  TaskMoveSessionFile,
  TaskMoveSessionFileRef,
  TaskMoveSessionsExport
} from '@slayzone/task-contracts'

/**
 * Copying a task's agent sessions from the computers that hold them to the computer
 * that keeps them now (`copy-sessions`): what the move between hubs runs through the
 * app, and what a move to a project on ANOTHER COMPUTER of the same hub runs inside
 * the hub. The two sides are APIs because the calls differ in who makes them, not in
 * what they do: the source side exports and reads, the target side stages, takes
 * and registers. Pure TypeScript — no React, no storage — so both can import it.
 */

/** Where the sessions come from. */
export interface SessionsSourceApi {
  /** Each computer of the task exports its chats; one answer. */
  sessionsExport(moveId: string, taskId: string): Promise<TaskMoveSessionsExport>
  /** A chunk (base64) of one exported chat. Empty past its end. */
  sessionsRead(input: {
    moveId: string
    taskId: string
    computerId: string
    conversationId: string
    offset: number
    length: number
  }): Promise<string>
  sessionsReadAttachment(input: {
    moveId: string
    taskId: string
    computerId: string
    conversationId: string
    epoch: number
    ref: TaskMoveAttachmentRef
  }): Promise<string>
  /** The exports go (their work is done, or the move was canceled). */
  sessionsDiscard(moveId: string): Promise<void>
  /** The files beside the task's chats (Claude transcripts, terminal scrollback). */
  sessionsFiles(moveId: string, taskId: string): Promise<TaskMoveSessionFile[]>
  sessionsFileRead(input: {
    moveId: string
    taskId: string
    computerId: string
    ref: TaskMoveSessionFileRef
    offset: number
    length: number
  }): Promise<{ data: string; eof: boolean }>
}

/** Where the sessions go. */
export interface SessionsTargetApi {
  /** Stage a chat on the task's computer, chunk by chunk, then take it. */
  sessionsBegin(
    moveId: string,
    taskId: string,
    manifest: TaskMoveChatTransfer['manifest']
  ): Promise<{ transferId: string; offset: number }>
  sessionsChunk(input: {
    moveId: string
    taskId: string
    transferId: string
    offset: number
    data: string
  }): Promise<void>
  sessionsFinish(
    moveId: string,
    taskId: string,
    transferId: string
  ): Promise<{ conversationId: string; epoch: number; missing: TaskMoveAttachmentRef[] }>
  sessionsPutAttachment(input: {
    moveId: string
    taskId: string
    conversationId: string
    epoch: number
    ref: TaskMoveAttachmentRef
    data: string
  }): Promise<void>
  sessionsActivate(input: {
    moveId: string
    taskId: string
    conversationId: string
    migrationId: string
    epoch: number
    hash: string
  }): Promise<void>
  sessionsImportLedger(moveId: string, taskId: string, ledger: unknown): Promise<void>
  sessionsFilesMissing(
    moveId: string,
    taskId: string,
    entries: Array<Omit<TaskMoveSessionFile, 'computerId'>>
  ): Promise<Array<Omit<TaskMoveSessionFile, 'computerId'> & { offset: number }>>
  sessionsFileWrite(input: {
    moveId: string
    taskId: string
    ref: TaskMoveSessionFileRef
    offset: number
    data: string
    complete?: { size: number; hash: string }
  }): Promise<void>
  /** The hub owns the chats the computer now holds. */
  sessionsRegister(
    moveId: string,
    taskId: string,
    chats: Array<{ id: string; tabId: string; mode: string; epoch: number }>
  ): Promise<void>
}

/** Bytes per chunk of a chat transfer (the computers' own chunk limit). */
export const TASK_MOVE_SESSION_CHUNK_BYTES = 256 * 1024

const base64Bytes = (data: string): number =>
  Math.ceil((data.length * 3) / 4) - (data.match(/=*$/)?.[0].length ?? 0)

/**
 * Every chat of every task of `move`, from the computer that holds it to the target's,
 * then the files beside them, the session ledger and the hub's ownership. Resumable at
 * any point: each call is idempotent (a transfer continues where the target's copy
 * stands, an activated chat is answered as it is). The source keeps its copy — the
 * caller decides what becomes of it.
 */
export async function copyMovedSessions(opts: {
  move: Pick<TaskMove, 'id' | 'taskIds'>
  source: SessionsSourceApi
  target: SessionsTargetApi
  reportProgress(done: number, total: number): Promise<void>
}): Promise<void> {
  const { move, source, target, reportProgress } = opts
  const exports = new Map<string, TaskMoveSessionsExport>()
  for (const taskId of move.taskIds)
    exports.set(taskId, await source.sessionsExport(move.id, taskId))
  let total = [...exports.values()]
    .flatMap((e) => e.transfers)
    .reduce((n, t) => n + t.manifest.bytes, 0)
  let done = 0
  await reportProgress(done, total)
  for (const taskId of move.taskIds) {
    const exported = exports.get(taskId)!
    const chats: Array<{ id: string; tabId: string; mode: string; epoch: number }> = []
    for (const transfer of exported.transfers) {
      const { manifest } = transfer
      const identity = manifest.header.identity
      const begun = await target.sessionsBegin(move.id, taskId, manifest)
      let offset = begun.offset
      done += offset
      while (offset < manifest.bytes) {
        const data = await source.sessionsRead({
          moveId: move.id,
          taskId,
          computerId: transfer.computerId,
          conversationId: identity.id,
          offset,
          length: TASK_MOVE_SESSION_CHUNK_BYTES
        })
        if (!data) throw new Error(`The export of chat ${identity.id} ended early.`)
        await target.sessionsChunk({
          moveId: move.id,
          taskId,
          transferId: begun.transferId,
          offset,
          data
        })
        offset += base64Bytes(data)
        done += base64Bytes(data)
        await reportProgress(done, total)
      }
      const staged = await target.sessionsFinish(move.id, taskId, begun.transferId)
      for (const ref of staged.missing) {
        const data = await source.sessionsReadAttachment({
          moveId: move.id,
          taskId,
          computerId: transfer.computerId,
          conversationId: identity.id,
          epoch: identity.epoch,
          ref
        })
        await target.sessionsPutAttachment({
          moveId: move.id,
          taskId,
          conversationId: staged.conversationId,
          epoch: staged.epoch,
          ref,
          data
        })
      }
      await target.sessionsActivate({
        moveId: move.id,
        taskId,
        conversationId: staged.conversationId,
        migrationId: manifest.header.migrationId,
        epoch: staged.epoch,
        hash: manifest.hash
      })
      chats.push({
        id: staged.conversationId,
        tabId: identity.tabId,
        mode: identity.mode,
        epoch: staged.epoch
      })
    }
    // The files beside the chats: transcripts (so the CLI session resumes) and scrollback.
    const files = await source.sessionsFiles(move.id, taskId)
    const missing = await target.sessionsFilesMissing(
      move.id,
      taskId,
      files.map(({ ref, size, hash }) => ({ ref, size, hash }))
    )
    total += missing.reduce((n, f) => n + f.size - f.offset, 0)
    for (const file of missing) {
      const computerId = files.find((f) => JSON.stringify(f.ref) === JSON.stringify(file.ref))!
        .computerId!
      let offset = file.offset
      for (;;) {
        const chunk = await source.sessionsFileRead({
          moveId: move.id,
          taskId,
          computerId,
          ref: file.ref,
          offset,
          length: TASK_MOVE_SESSION_CHUNK_BYTES
        })
        await target.sessionsFileWrite({
          moveId: move.id,
          taskId,
          ref: file.ref,
          offset,
          data: chunk.data,
          ...(chunk.eof ? { complete: { size: file.size, hash: file.hash } } : {})
        })
        offset += base64Bytes(chunk.data)
        done += base64Bytes(chunk.data)
        await reportProgress(done, total)
        if (chunk.eof) break
      }
    }
    await target.sessionsImportLedger(move.id, taskId, exported.ledger)
    await target.sessionsRegister(move.id, taskId, chats)
  }
  await source.sessionsDiscard(move.id)
}
