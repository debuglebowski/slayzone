import { randomUUID } from 'node:crypto'
import type {
  WorkspaceCaptureBegin,
  WorkspaceCaptureRequest,
  WorkspaceCaptureResult,
  WorkspaceChangesEvent,
  WorkspaceChangesRecord
} from '@slayzone/terminal-contracts'

export interface WorkspaceCaptureContext extends WorkspaceCaptureRequest {
  computerId: string | null
  projectId?: string | null
}
export interface WorkspaceCaptureBackend {
  begin(ctx: WorkspaceCaptureContext): Promise<WorkspaceCaptureBegin & { rootPath?: string }>
  finish(ctx: WorkspaceCaptureContext): Promise<WorkspaceCaptureResult>
  discard(ctx: WorkspaceCaptureContext): Promise<void>
}
export interface WorkspaceChangesStore {
  remove?(tabId: string, id: string): Promise<void>
  getFileDiff?(tabId: string, id: string, path: string): Promise<string | null>
  recover?(tabId: string): Promise<WorkspaceChangesEvent[]>
  begin(record: Omit<WorkspaceChangesRecord, 'status'> & { status: 'pending' }): Promise<void>
  save(record: WorkspaceChangesRecord): Promise<void>
  get(
    tabId: string,
    id: string
  ): Promise<
    | (Omit<WorkspaceChangesRecord, 'status'> & {
        status: 'pending' | WorkspaceCaptureResult['status']
      })
    | null
  >
}
interface Context {
  tabId: string
  gen: number
  rootPath: string
  computerId: string | null
  projectId?: string | null
}
interface Window {
  context: Context
  request: WorkspaceCaptureContext
  messageId: string
  begun: Promise<WorkspaceCaptureBegin>
  overlapped?: boolean
}

/** One observation window per actual turn. A barrier keeps the next turn out of its final snapshot. */
export class ChatWorkspaceTracker {
  private active: Window | null = null
  private closing: Promise<void> = Promise.resolve()
  private readonly finishing = new Set<Window>()
  constructor(
    private readonly deps: {
      backend: WorkspaceCaptureBackend
      store: WorkspaceChangesStore
      emit(event: WorkspaceChangesEvent): void
    }
  ) {}

  async beforeSend(context: Context, messageId: string): Promise<void> {
    await this.closing
    if (this.active?.context.gen === context.gen) {
      await this.active.begun
      return
    }
    if (this.active) await this.finish(this.active.context.gen, 'Agent process was replaced.')
    const request = { ...context, id: randomUUID(), scope: `${context.tabId}:${context.gen}` }
    const window: Window = {
      context,
      request,
      messageId,
      begun: Promise.resolve({ status: 'unavailable' })
    }
    this.active = window
    window.begun = this.begin(window)
    await window.begun
  }

  /** An unsolicited provider turn has already started: a late snapshot cannot be its baseline. */
  observeAgentTurn(context: Context): void {
    if (this.active?.context.gen === context.gen) return
    for (const window of this.finishing) window.overlapped = true
    const window: Window = {
      context,
      request: { ...context, id: randomUUID(), scope: `${context.tabId}:${context.gen}` },
      messageId: `agent-turn:${randomUUID()}`,
      begun: Promise.resolve({ status: 'unavailable' })
    }
    this.active = window
    window.begun = this.deps.store
      .begin({ ...this.identity(window), status: 'pending', files: [] })
      .then(() => ({
        status: 'unavailable' as const,
        reason: 'Agent started this turn without a workspace baseline.'
      }))
      .catch(() => ({
        status: 'unavailable' as const,
        reason: 'Workspace capture could not be saved.'
      }))
  }

  private async begin(window: Window): Promise<WorkspaceCaptureBegin> {
    let began: WorkspaceCaptureBegin & { rootPath?: string }
    try {
      began = await this.deps.backend.begin(window.request)
    } catch {
      began = { status: 'unavailable', reason: 'Workspace baseline unavailable.' }
    }
    if (began.rootPath) window.request.rootPath = began.rootPath
    try {
      await this.deps.store.begin({ ...this.identity(window), status: 'pending', files: [] })
      // Publish at the end of the turn, so a pending row never splits live assistant output.
    } catch {
      return { status: 'unavailable', reason: 'Workspace capture could not be saved.' }
    }
    return began
  }

  finish(gen: number, unavailableReason?: string): Promise<void> {
    const window = this.active
    if (!window || window.context.gen !== gen) return this.closing
    this.active = null
    this.finishing.add(window)
    const finished = this.finalize(window, unavailableReason).finally(() => {
      this.finishing.delete(window)
    })
    this.closing = Promise.all([this.closing, finished]).then(
      () => undefined,
      () => undefined
    )
    return this.closing
  }

  cancel(messageId: string): void {
    const window = this.active
    if (!window || window.messageId !== messageId) return
    this.active = null
    const discarded = window.begun
      .then(async () => {
        await this.deps.store.remove?.(window.context.tabId, window.request.id)
        await this.deps.backend.discard(window.request)
      })
      .catch(() => undefined)
    this.closing = Promise.all([this.closing, discarded]).then(() => undefined)
  }

  private identity(window: Window) {
    return {
      id: window.request.id,
      tabId: window.context.tabId,
      messageId: window.messageId,
      computerId: window.context.computerId,
      rootPath: window.request.rootPath
    }
  }

  private async finalize(window: Window, unavailableReason?: string): Promise<void> {
    const began = await window.begun
    const event = (status: WorkspaceChangesEvent['status'], fileCount: number, reason?: string) =>
      this.deps.emit({
        kind: 'workspace-changes',
        tabId: window.context.tabId,
        captureId: window.request.id,
        messageId: window.messageId,
        status,
        fileCount,
        ...(reason ? { reason } : {}),
        ...(unavailableReason && !window.overlapped && status === 'unavailable'
          ? { interrupted: true }
          : {})
      })
    event('pending', 0)
    let result: WorkspaceCaptureResult
    if (unavailableReason || began.status !== 'ready') {
      result = { status: 'unavailable', reason: unavailableReason ?? began.reason, files: [] }
    } else {
      try {
        result = await this.deps.backend.finish(window.request)
      } catch {
        result = {
          status: 'unavailable',
          reason: 'Workspace capture failed or computer disconnected.',
          files: []
        }
      }
    }
    if (window.overlapped)
      result = {
        status: 'unavailable',
        reason: 'Another agent turn started before the final workspace snapshot completed.',
        files: []
      }
    try {
      await this.deps.store.save({ ...this.identity(window), ...result })
      event(result.status, result.files.length, result.reason)
      // A failed persistence keeps the refs: do not destroy the only copy of the observation.
      void this.deps.backend.discard(window.request).catch(() => undefined)
    } catch {
      event('unavailable', 0, 'Workspace capture could not be saved.')
    }
  }
}
