/**
 * ClaudeSessionDriver — stateful per-spawn wrapper around the stateless
 * `claudeCodeAdapter`. It preserves the exact behavior the transport manager
 * used to implement inline (control_request/response correlation, ExitPlanMode
 * auto-deny) so the Claude chat path is byte-for-byte unchanged after the
 * driver-seam refactor; the only structural difference is that the protocol
 * logic now lives behind the shared `ChatSessionDriver` interface.
 *
 * @module agents/claude-session-driver
 */
import type { AgentEvent } from '../../shared/agent-events'
import { claudeCodeAdapter } from './claude-code-adapter'
import type { AgentBackend, ChatDriverContext, ChatSessionDriver, PermissionDecision } from './types'

interface PendingControl {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

class ClaudeSessionDriver implements ChatSessionDriver {
  private ctx: ChatDriverContext | null = null
  /** In-flight `control_request` promises, keyed by request_id. */
  private readonly pendingControl = new Map<string, PendingControl>()
  private controlReqCounter = 0

  start(ctx: ChatDriverContext): void {
    this.ctx = ctx
  }

  handleLine(line: string): void {
    const ev = claudeCodeAdapter.parseLine(line)
    if (!ev) return

    // Control responses route to the pending sender promise — they are
    // transport plumbing, not chat timeline events.
    if (ev.kind === 'control-response') {
      const pending = this.pendingControl.get(ev.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingControl.delete(ev.requestId)
        if (ev.isError) pending.reject(new Error(ev.error ?? 'control_request failed'))
        else pending.resolve(ev.data)
      }
      return
    }

    // Plan-mode `ExitPlanMode` arrives via stdio permission-prompt (we pass
    // `--permission-prompt-tool stdio`). The SDK only emits the
    // `result.permissionDenials` the renderer footer keys off AFTER receiving
    // a control_response, so auto-deny here; the renderer footer ("Approve &
    // exit plan") handles the user's actual decision.
    if (ev.kind === 'permission-request' && ev.toolName === 'ExitPlanMode') {
      const denyLine = claudeCodeAdapter.serializeControlResponse?.({
        requestId: ev.requestId,
        response: { behavior: 'deny', message: 'Plan mode requires explicit approval' }
      })
      if (denyLine != null) this.ctx?.write(denyLine)
      return
    }

    if (ev.kind === 'unknown' && ev.reason === 'unknown-type') {
      const raw = ev.raw as { type?: string } | null
      console.warn(`[chat-parser] unknown event type=${raw?.type ?? '<no-type>'}`)
    }

    this.ctx?.emit(ev)
  }

  sendUserMessage(text: string): void {
    if (!this.ctx) return
    this.ctx.write(claudeCodeAdapter.serializeUserMessage(text, this.ctx.sessionId))
  }

  sendToolResult(args: { toolUseId: string; content: string; isError?: boolean }): boolean {
    if (!this.ctx || !claudeCodeAdapter.serializeToolResult) return false
    const line = claudeCodeAdapter.serializeToolResult({
      toolUseId: args.toolUseId,
      content: args.content,
      isError: args.isError,
      sessionId: this.ctx.sessionId
    })
    if (line == null) return false
    this.ctx.write(line)
    return true
  }

  applyControl(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.ctx) return Promise.reject(new Error('driver not started'))
    if (!claudeCodeAdapter.serializeControlRequest) {
      return Promise.reject(new Error('adapter has no control channel'))
    }
    this.controlReqCounter++
    const requestId = `req_${this.controlReqCounter}_${Date.now().toString(36)}`
    const line = claudeCodeAdapter.serializeControlRequest({ requestId, request })
    if (line == null) {
      return Promise.reject(new Error('adapter refused to serialize control_request'))
    }
    const ctx = this.ctx
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId)
        reject(new Error(`control_request timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingControl.set(requestId, { resolve, reject, timer })
      try {
        ctx.write(line)
      } catch (err) {
        clearTimeout(timer)
        this.pendingControl.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  respondPermission(args: { requestId: string; decision: PermissionDecision }): boolean {
    if (!this.ctx || !claudeCodeAdapter.serializeControlResponse) return false
    const line = claudeCodeAdapter.serializeControlResponse({
      requestId: args.requestId,
      response: args.decision as unknown as Record<string, unknown>
    })
    if (line == null) return false
    try {
      this.ctx.write(line)
      return true
    } catch {
      return false
    }
  }

  extractSessionId(event: AgentEvent): string | null {
    return claudeCodeAdapter.extractSessionId(event)
  }

  dispose(): void {
    for (const [id, pending] of this.pendingControl) {
      clearTimeout(pending.timer)
      pending.reject(new Error('session ended before control_response'))
      this.pendingControl.delete(id)
    }
  }
}

/**
 * `AgentBackend` for the `claude-chat` mode. `buildSpawnArgs` delegates to the
 * stateless adapter; `createDriver` mints one `ClaudeSessionDriver` per spawn.
 */
export const claudeChatBackend: AgentBackend = {
  binaryName: claudeCodeAdapter.binaryName,
  buildSpawnArgs: (opts) => claudeCodeAdapter.buildSpawnArgs(opts),
  createDriver: () => new ClaudeSessionDriver()
}
