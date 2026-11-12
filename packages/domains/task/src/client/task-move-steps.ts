import type {
  ImportTaskMoveInput,
  TaskMoveAttachmentRef,
  TaskMoveBundle,
  TaskMoveChatTransfer,
  TaskMoveSessionFile,
  TaskMoveSessionFileRef,
  TaskMoveSessionsExport
} from '@slayzone/task-contracts'
import type { TaskMoveStepRunner, TaskMoveWorkStep } from './task-move-engine'

/** One artifact file a move copies (`artifacts.move*`): a version blob or a working copy. */
export type TaskMoveFileRef =
  | { kind: 'blob'; hash: string }
  | { kind: 'file'; taskId: string; path: string }
export interface TaskMoveFileEntry {
  ref: TaskMoveFileRef
  size: number
  hash: string
}

/** The hub the tasks leave. */
/** One hub's side of a blocker a move splits between two hubs. */
export interface TaskMoveRemoteBlockerLink {
  taskId: string
  role: 'blocks' | 'blocked_by'
  remoteHubId: string
  remoteTaskId: string
  remoteTitle: string | null
}

export interface TaskMoveSourceApi {
  exportBundle(moveId: string): Promise<TaskMoveBundle>
  /** `copy-sessions`: each computer of the task exports its chats; one answer. */
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
  addRemoteBlockers(moveId: string, links: TaskMoveRemoteBlockerLink[]): Promise<void>
  fileManifest(moveId: string): Promise<TaskMoveFileEntry[]>
  readFile(
    moveId: string,
    ref: TaskMoveFileRef,
    offset: number,
    length: number
  ): Promise<{ data: string; eof: boolean }>
}

/** The hub the tasks go to. */
export interface TaskMoveTargetApi {
  importBundle(input: ImportTaskMoveInput): Promise<void>
  /** `copy-sessions`: stage a chat on the task's computer, chunk by chunk, then take it. */
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
  addRemoteBlockers(moveId: string, links: TaskMoveRemoteBlockerLink[]): Promise<void>
  missingFiles(
    moveId: string,
    entries: TaskMoveFileEntry[]
  ): Promise<Array<TaskMoveFileEntry & { offset: number }>>
  writeFile(input: {
    moveId: string
    ref: TaskMoveFileRef
    offset: number
    data: string
    complete?: { size: number; hash: string }
  }): Promise<void>
  clearStaging(moveId: string): Promise<void>
  commit(moveId: string): Promise<void>
}

/** Bytes per chunk the app relays from one hub to the other. */
export const TASK_MOVE_CHUNK_BYTES = 512 * 1024
/** Bytes per chunk of a chat transfer (the computers' own chunk limit). */
export const TASK_MOVE_SESSION_CHUNK_BYTES = 256 * 1024

const base64Bytes = (data: string): number =>
  Math.ceil((data.length * 3) / 4) - (data.match(/=*$/)?.[0].length ?? 0)

/**
 * The work of each step of a move between hubs, for {@link runTaskMove}. Each is
 * safe to run again: `export` is a read, `import` and `commit` are idempotent on the
 * target. The bundle read by `export` is kept for `import`; after a resume (another
 * run, another device) `import` reads it again.
 */
export function createTaskMoveSteps(opts: {
  /** The source hub's id in the app's registry: the target records where tasks came from. */
  sourceHubId: string
  source: TaskMoveSourceApi
  target: TaskMoveTargetApi
}): Record<TaskMoveWorkStep, TaskMoveStepRunner> {
  const bundles = new Map<string, TaskMoveBundle>()
  const bundleOf = async (moveId: string): Promise<TaskMoveBundle> => {
    const known = bundles.get(moveId)
    if (known) return known
    const bundle = await opts.source.exportBundle(moveId)
    bundles.set(moveId, bundle)
    return bundle
  }
  return {
    export: async ({ move }) => {
      await bundleOf(move.id)
    },
    import: async ({ move }) => {
      await opts.target.importBundle({
        sourceHubId: opts.sourceHubId,
        targetProjectId: move.targetProjectId,
        bundle: await bundleOf(move.id)
      })
    },
    // Every file the target lacks, chunk by chunk from where its copy stands; progress
    // in bytes over everything still to copy.
    'copy-files': async ({ move, reportProgress }) => {
      const manifest = await opts.source.fileManifest(move.id)
      const missing = await opts.target.missingFiles(move.id, manifest)
      const total = missing.reduce((n, f) => n + f.size, 0)
      let done = missing.reduce((n, f) => n + f.offset, 0)
      await reportProgress(done, total)
      for (const file of missing) {
        let offset = file.offset
        for (;;) {
          const chunk = await opts.source.readFile(move.id, file.ref, offset, TASK_MOVE_CHUNK_BYTES)
          const bytes =
            Math.ceil((chunk.data.length * 3) / 4) - (chunk.data.match(/=*$/)?.[0].length ?? 0)
          await opts.target.writeFile({
            moveId: move.id,
            ref: file.ref,
            offset,
            data: chunk.data,
            ...(chunk.eof ? { complete: { size: file.size, hash: file.hash } } : {})
          })
          offset += bytes
          done += bytes
          await reportProgress(done, total)
          if (chunk.eof) break
        }
      }
      await opts.target.clearStaging(move.id)
    },
    // The tasks' agent sessions: every chat of every task, from the computer that holds
    // it to the target's computer, then the session ledger, then the target hub owns
    // them. Resumable at any point (each call is idempotent: a transfer continues
    // where the target's copy stands, an activated chat is answered as it is). The
    // source computers keep their copy: the task can move back, or the move be canceled.
    'copy-sessions': async ({ move, reportProgress }) => {
      if (!move.includeSessions) return
      const exports = new Map<string, TaskMoveSessionsExport>()
      for (const taskId of move.taskIds)
        exports.set(taskId, await opts.source.sessionsExport(move.id, taskId))
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
          const begun = await opts.target.sessionsBegin(move.id, taskId, manifest)
          let offset = begun.offset
          done += offset
          while (offset < manifest.bytes) {
            const data = await opts.source.sessionsRead({
              moveId: move.id,
              taskId,
              computerId: transfer.computerId,
              conversationId: identity.id,
              offset,
              length: TASK_MOVE_SESSION_CHUNK_BYTES
            })
            if (!data) throw new Error(`The export of chat ${identity.id} ended early.`)
            await opts.target.sessionsChunk({
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
          const staged = await opts.target.sessionsFinish(move.id, taskId, begun.transferId)
          for (const ref of staged.missing) {
            const data = await opts.source.sessionsReadAttachment({
              moveId: move.id,
              taskId,
              computerId: transfer.computerId,
              conversationId: identity.id,
              epoch: identity.epoch,
              ref
            })
            await opts.target.sessionsPutAttachment({
              moveId: move.id,
              taskId,
              conversationId: staged.conversationId,
              epoch: staged.epoch,
              ref,
              data
            })
          }
          await opts.target.sessionsActivate({
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
        const files = await opts.source.sessionsFiles(move.id, taskId)
        const missing = await opts.target.sessionsFilesMissing(
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
            const chunk = await opts.source.sessionsFileRead({
              moveId: move.id,
              taskId,
              computerId,
              ref: file.ref,
              offset,
              length: TASK_MOVE_SESSION_CHUNK_BYTES
            })
            await opts.target.sessionsFileWrite({
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
        await opts.target.sessionsImportLedger(move.id, taskId, exported.ledger)
        await opts.target.sessionsRegister(move.id, taskId, chats)
      }
      await opts.source.sessionsDiscard(move.id)
    },
    // A blocker between a moved task and one staying behind: each hub keeps its side.
    links: async ({ move }) => {
      const bundle = await bundleOf(move.id)
      if (bundle.externalDependencies.length === 0) return
      const titles = new Map(
        (bundle.rows.tasks ?? []).map((t) => [t.id as string, (t.title as string) ?? null])
      )
      const onTarget: TaskMoveRemoteBlockerLink[] = []
      const onSource: TaskMoveRemoteBlockerLink[] = []
      for (const d of bundle.externalDependencies) {
        // `task_id` blocks `blocks_task_id`; one of them moved.
        const movedBlocks = titles.has(d.task_id)
        const moved = movedBlocks ? d.task_id : d.blocks_task_id
        const staying = movedBlocks ? d.blocks_task_id : d.task_id
        onTarget.push({
          taskId: moved,
          role: movedBlocks ? 'blocks' : 'blocked_by',
          remoteHubId: opts.sourceHubId,
          remoteTaskId: staying,
          remoteTitle: d.staying_title || null
        })
        onSource.push({
          taskId: staying,
          role: movedBlocks ? 'blocked_by' : 'blocks',
          remoteHubId: move.peerHubId,
          remoteTaskId: moved,
          remoteTitle: titles.get(moved) ?? null
        })
      }
      await opts.target.addRemoteBlockers(move.id, onTarget)
      await opts.source.addRemoteBlockers(move.id, onSource)
    },
    commit: async ({ move }) => {
      await opts.target.commit(move.id)
      bundles.delete(move.id)
    }
  }
}
