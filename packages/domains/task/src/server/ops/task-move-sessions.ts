import type { SlayzoneDb } from '@slayzone/platform'
import type {
  TaskMoveAttachmentRef,
  TaskMoveChatTransfer,
  TaskMoveSessionFile,
  TaskMoveSessionFileRef,
  TaskMoveSessionsExport
} from '@slayzone/task-contracts'
import { TaskMoveRefusedError } from './task-moves.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

/**
 * A moved task's agent sessions (`copy-sessions`): what its chats' computers hold.
 * The hub's composition installs the delegate (it reaches the computers); the move's
 * steps call it through the `taskMoves.sessions*` procedures, on the source hub
 * (`export`, `read`, `readAttachment`, `discard`) and on the target hub (the rest).
 * Every call is safe to repeat. Without a delegate (tests, a hub with no computers)
 * the procedures refuse.
 */
export interface TaskMoveSessionsDelegate {
  // --- The hub the task leaves ---
  /** Each of the task's computers exports its chats (frozen only for one read); one answer. */
  exportTask(moveId: string, taskId: string): Promise<TaskMoveSessionsExport>
  /** A chunk (base64) of a chat's exported transfer. */
  read(input: {
    moveId: string
    computerId: string
    conversationId: string
    offset: number
    length: number
  }): Promise<string>
  /** One of the chat's attachments (base64), at the chat's exported epoch. */
  readAttachment(input: {
    computerId: string
    conversationId: string
    epoch: number
    ref: TaskMoveAttachmentRef
  }): Promise<string>
  /** The move's exports go, on every computer that made one. */
  discard(moveId: string, taskIds: readonly string[]): Promise<void>
  /** The files beside the task's chats (Claude transcripts, scrollback), with their computers. */
  files(moveId: string, taskId: string): Promise<TaskMoveSessionFile[]>
  /** A chunk (base64) of one of them; `eof` on the last. */
  readFile(input: {
    moveId: string
    taskId: string
    computerId: string
    ref: TaskMoveSessionFileRef
    offset: number
    length: number
  }): Promise<{ data: string; eof: boolean }>

  // --- The hub the task arrives at ---
  /** The computer this hub keeps the task's sessions on. */
  computerOf(taskId: string): Promise<string>
  begin(
    taskId: string,
    manifest: TaskMoveChatTransfer['manifest']
  ): Promise<{ transferId: string; offset: number }>
  chunk(taskId: string, transferId: string, offset: number, data: string): Promise<void>
  /** The chat is staged; `missing` are the attachments it still needs. */
  finish(
    taskId: string,
    transferId: string
  ): Promise<{ conversationId: string; epoch: number; missing: TaskMoveAttachmentRef[] }>
  putAttachment(input: {
    taskId: string
    conversationId: string
    epoch: number
    ref: TaskMoveAttachmentRef
    data: string
  }): Promise<void>
  activate(input: {
    taskId: string
    conversationId: string
    migrationId: string
    epoch: number
    hash: string
  }): Promise<void>
  importLedger(taskId: string, ledger: unknown): Promise<void>
  /** Of these files, the ones the task's computer here lacks, and where its staged copy stands. */
  missingFiles(
    taskId: string,
    entries: Array<Omit<TaskMoveSessionFile, 'computerId'>>
  ): Promise<Array<Omit<TaskMoveSessionFile, 'computerId'> & { offset: number }>>
  writeFile(input: {
    taskId: string
    ref: TaskMoveSessionFileRef
    offset: number
    data: string
    complete?: { size: number; hash: string }
  }): Promise<void>
  /** After the chats were registered: have the computer's chats read again (recovery). */
  settle(computerId: string): Promise<void>
}

let delegate: TaskMoveSessionsDelegate | null = null
export function setTaskMoveSessionsDelegate(value: TaskMoveSessionsDelegate | null): void {
  delegate = value
}
export function taskMoveSessions(): TaskMoveSessionsDelegate {
  if (!delegate)
    throw new TaskMoveRefusedError('This hub cannot move agent sessions: it has no computers.')
  return delegate
}

/**
 * The target hub takes the chats the computer now holds: one ownership row per chat,
 * bound to its tab, at the epoch the computer staged them with. Then its chats are
 * read again, so what an earlier look (at an older epoch) fenced is cleared.
 */
export async function registerMovedChats(
  db: SlayzoneDb,
  input: {
    taskId: string
    chats: Array<{ id: string; tabId: string; mode: string; epoch: number }>
  }
): Promise<void> {
  const sessions = taskMoveSessions()
  const computerId = await sessions.computerOf(input.taskId)
  await db.namedTxn('task:register-moved-chats', {
    taskId: input.taskId,
    computerId,
    chats: input.chats
  })
  await sessions.settle(computerId)
}
