/**
 * Minimal hand-written subset of the Codex `app-server` JSON-RPC protocol —
 * only the request params, response shapes, and notification payloads the
 * `CodexChatSession` driver actually consumes.
 *
 * The full machine-generated bindings (450+ files) live outside the repo;
 * regenerate + diff against this file on a `codex` CLI upgrade with:
 *   codex app-server generate-ts --out <dir>
 * See `test/fixtures/codex-app-server/SPIKE.md`. Verified: codex-cli 0.132.0.
 *
 * @module agents/codex/codex-protocol
 */

/** `initialize` request params. */
export interface CodexInitializeParams {
  clientInfo: { name: string; title: string | null; version: string }
  capabilities: { experimentalApi: boolean; requestAttestation: boolean }
}

/** `thread/start` / `thread/resume` request params (subset). */
export interface CodexThreadStartParams {
  cwd?: string
  model?: string
  approvalPolicy?: CodexApprovalPolicy
  sandbox?: CodexSandboxMode
}
export interface CodexThreadResumeParams extends CodexThreadStartParams {
  threadId: string
}

/** `thread/start` / `thread/resume` response (subset). */
export interface CodexThreadStartResponse {
  thread: { id: string }
  model: string
  cwd: string
  reasoningEffort?: string | null
}

/** `turn/start` request params (subset). */
export interface CodexTurnStartParams {
  threadId: string
  input: CodexUserInput[]
  approvalPolicy?: CodexApprovalPolicy
  sandboxPolicy?: CodexSandboxPolicy
  model?: string
  effort?: CodexReasoningEffort
  collaborationMode?: CodexCollaborationMode
  /** OpenAI service tier. `'fast'` enables Codex Fast Mode (faster delivery). */
  serviceTier?: string
}
export type CodexUserInput = { type: 'text'; text: string; text_elements: [] }

/** Codex collaboration mode kind — the behavioral axis (`turn/start`). */
export type CodexModeKind = 'plan' | 'default'
/**
 * `turn/start.collaborationMode` — Codex's native `CollaborationMode`. `mode`
 * is server-enforced (gates the `request_user_input` / `update_plan` tools);
 * `settings.developer_instructions` carries the behavioral `<collaboration_mode>`
 * prompt. Note the snake_case settings keys — the app-server expects them.
 */
export interface CodexCollaborationMode {
  mode: CodexModeKind
  settings: {
    model: string
    reasoning_effort: CodexReasoningEffort
    developer_instructions: string
  }
}

export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** `turn/start` response. */
export interface CodexTurnStartResponse {
  turn: { id: string }
}

// ---- Notification payloads ----

export interface CodexThreadItemBase {
  type: string
  id: string
}
/** `agentMessage` thread item. */
export interface CodexAgentMessageItem extends CodexThreadItemBase {
  type: 'agentMessage'
  text: string
}
/** `reasoning` thread item. */
export interface CodexReasoningItem extends CodexThreadItemBase {
  type: 'reasoning'
  summary: string[]
  content: string[]
}
/** `commandExecution` thread item (subset). */
export interface CodexCommandExecutionItem extends CodexThreadItemBase {
  type: 'commandExecution'
  command: string
  cwd: string
  status: 'inProgress' | 'completed' | 'failed' | 'declined'
  aggregatedOutput: string | null
  exitCode: number | null
}
/** `fileChange` thread item (subset). */
export interface CodexFileChangeItem extends CodexThreadItemBase {
  type: 'fileChange'
  changes: unknown[]
  status: 'inProgress' | 'completed' | 'failed' | 'declined'
}

export type CodexThreadItem = CodexThreadItemBase &
  Record<string, unknown> & { type: string; id: string }

export interface CodexItemNotification {
  item: CodexThreadItem
  threadId: string
  turnId: string
}
export interface CodexDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}
export interface CodexTurnNotification {
  threadId: string
  turn: {
    id: string
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
    error: { message: string } | null
    durationMs: number | null
  }
}
export interface CodexErrorNotification {
  error: { message: string }
  willRetry: boolean
  threadId: string
  turnId: string
}
export interface CodexPlanNotification {
  threadId: string
  turnId: string
  explanation: string | null
  plan: { step: string; status: 'pending' | 'inProgress' | 'completed' }[]
}
export interface CodexTokenUsageNotification {
  threadId: string
  turnId: string
  tokenUsage: {
    total: CodexTokenBreakdown
    last: CodexTokenBreakdown
    modelContextWindow: number | null
  }
}
export interface CodexTokenBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

/** Approval decision sent back to the server (command + file-change share enough). */
export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
