/**
 * Codex app-server protocol drift check: the driver (`codex-chat-session.ts`)
 * against the protocol of the pinned CLI version.
 *
 * Inputs (both committed, both from the same CLI):
 *  - `@slayzone/test-utils/fake-codex/protocol-surface.json`: every method the
 *    server can send, every server request and the decisions it accepts, every
 *    client request with its params, the thread item types and status enums;
 *  - the recorded real runs (`fake-codex/transcripts/*.jsonl`).
 *
 * What fails here:
 *  - a server notification, server request or thread item type that is neither
 *    HANDLED by the driver nor listed below with the reason it is not;
 *  - a list entry the protocol no longer has (stale);
 *  - a list that lies: an "ignored" method the driver does turn into events, or
 *    a "handled" one that produces nothing;
 *  - a request the driver sends that the protocol does not have, a param it
 *    sends that the request does not accept, a required param it leaves out, or
 *    an enum value (approval policy, sandbox, decision) outside the schema;
 *  - a recorded line the driver cannot parse or a method outside the surface.
 *
 * After a CLI update:
 *   1. install it aside: `npm i --prefix <dir> @openai/codex@<version>`;
 *   2. `SLAYZONE_CODEX_BIN_PATH=<dir>/node_modules/.bin/codex npx tsx
 *      packages/domains/terminal/src/server/agents/codex/codex-protocol-surface.gen.ts`;
 *   3. re-record: same env, `npx tsx …/codex-app-server-recorder.live.ts`;
 *   4. bump `FAKE_CODEX_VERSION` (fake-codex.mjs + index.ts) and run this. Every
 *      failure is something the new CLI does that the driver does not know yet.
 *
 * The installed `codex` differing from the pinned version is reported and the
 * test skipped; `SLAYZONE_CODEX_DRIFT_STRICT=1` (CI for a CLI bump) fails it.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { chatModesForMode } from '@slayzone/terminal-contracts'
import {
  FAKE_CODEX_VERSION,
  listCodexTranscripts,
  readCodexProtocolSurface,
  readTranscript
} from '@slayzone/test-utils/fake-codex'
import { expectKnownBug } from '@slayzone/test-utils/known-bug'
import type { ChatDriverContext, ChatSessionDriver, PermissionDecision } from '../types'
import { codexChatBackend } from './codex-chat-session'

const surface = readCodexProtocolSurface()

// --- classification ---------------------------------------------------------------

/** Notifications the driver turns into chat events (`onNotification`). */
const HANDLED_NOTIFICATIONS = new Set([
  'turn/started',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'thread/tokenUsage/updated',
  'turn/plan/updated',
  'turn/completed',
  'error',
  'serverRequest/resolved',
  'item/commandExecution/outputDelta'
])

/** Handled, but on their own they emit nothing (state the driver keeps). */
const HANDLED_SILENT: Record<string, string> = {
  'turn/started': 'stores the turn id `turn/interrupt` needs',
  'item/commandExecution/outputDelta': 'kept for the command card to poll (`commandTaskOutput`)',
  'serverRequest/resolved': 'closes a card only while its request is still pending'
}

/**
 * Notifications that carry something chat should show, dropped today. Each is a
 * gap, not noise: the reason says what is lost (X0 report lists them).
 */
const KNOWN_UNHANDLED: Record<string, string> = {
  'item/commandExecution/terminalInteraction': 'input written to an interactive command',
  'item/fileChange/outputDelta': 'live progress of a patch being applied',
  'item/fileChange/patchUpdated': 'a patch changed while it was being applied',
  'item/mcpToolCall/progress': 'progress of a running MCP tool',
  'item/plan/delta': 'plan-mode plan text, streamed',
  'item/reasoning/summaryPartAdded':
    'section break between reasoning summary parts (parts run together)',
  'turn/diff/updated': "the turn's unified diff (files-changed panel)",
  'thread/compacted': 'context was compacted',
  'thread/status/changed': 'active/idle, `waitingOnApproval`, `systemError` flags',
  'thread/name/updated': 'the thread title',
  'hook/started': 'a hook run starts (Claude chat shows hook output)',
  'hook/completed': 'a hook run finished, possibly blocking',
  'item/autoApprovalReview/started': 'the auto-reviewer looks at an action',
  'item/autoApprovalReview/completed': "the auto-reviewer's verdict",
  'autoApprovalReview/strictReviewRequired': 'the auto-reviewer demands a strict review',
  'mcpServer/startupStatus/updated': 'an MCP server failed to start (status `failed`)',
  'model/rerouted': 'the turn runs on another model than chosen',
  'model/verification': 'model verification state',
  'model/safetyBuffering/updated': 'output held back by safety buffering',
  'modelProvider/authRecoveryStarted': 'login being recovered (turn may stall)',
  'modelProvider/authRecoveryCompleted': 'login recovered',
  'account/rateLimits/updated': 'usage-limit meter',
  warning: 'a warning, e.g. "Model metadata for `x` not found" (recipe bad-model)',
  configWarning: 'a config.toml problem',
  deprecationNotice: 'a deprecated setting or API',
  guardianWarning: 'a guardian (safety) warning',
  'windows/worldWritableWarning': 'Windows: the workspace is world-writable'
}

/** Notifications with nothing for chat: APIs chat never calls, or echoes of what it knows. */
const KNOWN_IGNORED: Record<string, string> = {
  'thread/started': 'echo of the thread/start reply',
  'thread/settings/updated': 'echo of the settings chat sent with turn/start',
  'thread/archived': 'thread lifecycle API unused',
  'thread/unarchived': 'thread lifecycle API unused',
  'thread/deleted': 'thread lifecycle API unused',
  'thread/closed': 'thread lifecycle API unused',
  'thread/reverted': 'thread/revert API unused',
  'thread/attachment/updated': 'thread attachments API unused',
  'thread/goal/updated': 'thread goals API unused',
  'thread/goal/cleared': 'thread goals API unused',
  'thread/queue/changed': 'server-side message queue API unused (chat has its own outbox)',
  'thread/project/updated': 'Codex projects API unused',
  'project/changed': 'Codex projects API unused',
  'thread/environment/connected': 'remote environments unused',
  'thread/environment/disconnected': 'remote environments unused',
  'skills/changed': 'skills list API unused',
  'command/exec/outputDelta': 'command/exec API unused',
  'process/outputDelta': 'process API unused',
  'process/exited': 'process API unused',
  'mcpServer/oauthLogin/completed': 'MCP OAuth login API unused',
  'mcpServer/event/stream/notification': 'MCP event stream API unused',
  'account/updated': 'auth mode / plan; chat shows no account',
  'account/gatewayOAuth/changed': 'gateway OAuth API unused',
  'account/login/completed': 'login API unused (chat reuses `codex login`)',
  'app/list/updated': 'apps API unused',
  'remoteControl/status/changed': 'remote-control API unused',
  'externalAgentConfig/import/progress': 'config import API unused',
  'externalAgentConfig/import/completed': 'config import API unused',
  'fs/changed': 'fs/watch API unused',
  'turn/moderationMetadata': 'moderation bookkeeping, nothing to show',
  'fuzzyFileSearch/sessionUpdated': 'fuzzy file search API unused',
  'fuzzyFileSearch/sessionCompleted': 'fuzzy file search API unused',
  'thread/realtime/started': 'realtime (voice) API unused',
  'thread/realtime/itemAdded': 'realtime (voice) API unused',
  'thread/realtime/item/started': 'realtime (voice) API unused',
  'thread/realtime/item/transcript/delta': 'realtime (voice) API unused',
  'thread/realtime/item/completed': 'realtime (voice) API unused',
  'thread/realtime/transcript/delta': 'realtime (voice) API unused',
  'thread/realtime/transcript/done': 'realtime (voice) API unused',
  'thread/realtime/outputAudio/delta': 'realtime (voice) API unused',
  'thread/realtime/sdp': 'realtime (voice) API unused',
  'thread/realtime/error': 'realtime (voice) API unused',
  'thread/realtime/closed': 'realtime (voice) API unused',
  'windowsSandbox/setupCompleted': 'Windows sandbox setup API unused'
}

/** Server→client requests the user answers from a card (→ `permission-request`). */
const HANDLED_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval'
])

/** Requests the driver answers itself, with no card. */
const HANDLED_SILENT_REQUESTS: Record<string, string> = {
  'currentTime/read': "answered with the host's clock"
}

/** Requests the driver refuses (-32601) though the user should see them. */
const KNOWN_UNHANDLED_REQUESTS: Record<string, string> = {}

/** Requests that cannot reach chat's sessions. */
const KNOWN_IGNORED_REQUESTS: Record<string, string> = {
  'item/tool/call': 'dynamic tools: chat registers none',
  'account/chatgptAuthTokens/refresh':
    'only for externally managed ChatGPT tokens; chat uses `codex login`',
  'attestation/generate': 'chat sends requestAttestation:false'
}

/** Thread item types the driver shows (stream or tool card). */
const HANDLED_ITEMS = new Set([
  'agentMessage',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'userMessage',
  'contextCompaction'
])
const HANDLED_SILENT_ITEMS: Record<string, string> = {
  userMessage: 'echo of the message chat already recorded'
}
/** Item types dropped today (nothing reaches the timeline). */
const KNOWN_UNHANDLED_ITEMS: Record<string, string> = {
  plan: 'plan-mode proposed plan',
  imageView: 'an image the agent looked at',
  imageGeneration: 'an image the agent generated',
  collabAgentToolCall: 'a call to a collaborating agent',
  subAgentActivity: 'sub-agent activity',
  enteredReviewMode: 'review mode started',
  exitedReviewMode: 'review mode ended (carries the review)',
  hookPrompt: 'a hook injected a prompt',
  functionCallOutput: 'raw function call output',
  sleep: 'the agent waits'
}

// --- driver harness ---------------------------------------------------------------

type Json = Record<string, unknown>
type CodexDriver = ChatSessionDriver &
  Required<Pick<ChatSessionDriver, 'applyControl' | 'respondPermission'>>

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

interface Harness {
  driver: CodexDriver
  sent: Json[]
  emitted: AgentEvent[]
  parseErrors: string[]
  feed(line: string): Promise<AgentEvent[]>
}

async function harness(ctx: Partial<ChatDriverContext> = {}, handshake = true): Promise<Harness> {
  const sent: Json[] = []
  const emitted: AgentEvent[] = []
  const parseErrors: string[] = []
  const driver = codexChatBackend.createDriver() as CodexDriver
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    parseErrors.push(args.map(String).join(' '))
  })
  void driver.start({
    write: (line) => sent.push(JSON.parse(line) as Json),
    emit: (event) => emitted.push(event),
    cwd: '/work',
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: 'gpt-6-luna',
    chatEffort: null,
    chatMode: 'auto-accept-edits',
    chatCollaboration: null,
    chatFastMode: false,
    ...ctx
  })
  const h: Harness = {
    driver,
    sent,
    emitted,
    parseErrors,
    async feed(line) {
      const before = emitted.length
      driver.handleLine(line)
      await flush()
      return emitted.slice(before)
    }
  }
  if (handshake) {
    await flush()
    await h.feed(JSON.stringify({ id: 1, result: { userAgent: 'x' } }))
    await h.feed(
      JSON.stringify({ id: 2, result: { thread: { id: 'th' }, model: 'm', cwd: '/work' } })
    )
  }
  warn.mockRestore()
  return h
}

/** Minimal params under which each handled notification does its work. */
const SAMPLE: Record<string, Json> = {
  'item/started': { item: { type: 'commandExecution', id: 'i1', command: 'ls', cwd: '/w' } },
  'item/completed': { item: { type: 'commandExecution', id: 'i1', status: 'completed' } },
  'item/agentMessage/delta': { itemId: 'a1', delta: 'hi' },
  'item/reasoning/textDelta': { itemId: 'r1', delta: 'hm' },
  'item/reasoning/summaryTextDelta': { itemId: 'r1', delta: 'hm' },
  'turn/plan/updated': { explanation: null, plan: [{ step: 's', status: 'pending' }] },
  'turn/completed': { turn: { id: 't', status: 'completed', durationMs: 1 } },
  'thread/tokenUsage/updated': {
    tokenUsage: {
      last: { totalTokens: 10, inputTokens: 9, cachedInputTokens: 0, outputTokens: 1 },
      total: { totalTokens: 10, inputTokens: 9, cachedInputTokens: 0, outputTokens: 1 },
      modelContextWindow: 100
    }
  },
  error: { error: { message: 'x' }, willRetry: false }
}

// --- the checks --------------------------------------------------------------------

describe('codex protocol drift: pinned version', () => {
  it('surface, fake and every transcript are from the same CLI version', () => {
    expect(surface.cliVersion).toBe(FAKE_CODEX_VERSION)
    for (const { recipe, file } of listCodexTranscripts()) {
      expect({ recipe, version: readTranscript(file)[0] }).toMatchObject({
        recipe,
        version: { kind: 'header', cliVersion: surface.cliVersion }
      })
    }
  })

  it('the installed codex is the pinned version (strict: SLAYZONE_CODEX_DRIFT_STRICT=1)', (ctx) => {
    let installed: string | null = null
    try {
      installed =
        execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim().split(' ').at(-1) ?? null
    } catch {
      installed = null
    }
    if (installed === surface.cliVersion) return
    const note =
      `installed codex ${installed ?? '(none)'} ≠ pinned ${surface.cliVersion}: the committed ` +
      "surface + transcripts describe the pinned CLI; see this file's header to move the pin."
    if (process.env.SLAYZONE_CODEX_DRIFT_STRICT === '1') throw new Error(note)
    console.warn(`[codex-drift] ${note}`)
    ctx.skip()
  })
})

describe('codex protocol drift: classification is complete and true', () => {
  const lists = [HANDLED_NOTIFICATIONS, KNOWN_UNHANDLED, KNOWN_IGNORED]
  const inList = (m: string): number =>
    lists.filter((l) => (l instanceof Set ? l.has(m) : m in l)).length

  it('every server notification is handled or listed exactly once', () => {
    const unclassified = Object.keys(surface.serverNotifications).filter((m) => inList(m) !== 1)
    expect(unclassified).toEqual([])
  })

  it('no list names a notification the protocol does not have', () => {
    const all = [
      ...HANDLED_NOTIFICATIONS,
      ...Object.keys(KNOWN_UNHANDLED),
      ...Object.keys(KNOWN_IGNORED)
    ]
    expect(all.filter((m) => !(m in surface.serverNotifications))).toEqual([])
  })

  it('unhandled and ignored notifications really produce nothing', async () => {
    const h = await harness()
    const loud: string[] = []
    for (const m of [...Object.keys(KNOWN_UNHANDLED), ...Object.keys(KNOWN_IGNORED)]) {
      const out = await h.feed(
        JSON.stringify({
          method: m,
          params: { threadId: 'th', turnId: 't', itemId: 'i', delta: 'x' }
        })
      )
      if (out.length > 0) loud.push(`${m} → ${out.map((e) => e.kind).join(',')}`)
    }
    expect(loud).toEqual([])
  })

  it('handled notifications really produce events (except the silent ones)', async () => {
    const quiet: string[] = []
    for (const m of HANDLED_NOTIFICATIONS) {
      if (m in HANDLED_SILENT) continue
      const h = await harness()
      const out = await h.feed(
        JSON.stringify({ method: m, params: { threadId: 'th', turnId: 't', ...SAMPLE[m] } })
      )
      if (out.length === 0) quiet.push(m)
    }
    expect(quiet).toEqual([])
  })

  it('every server request is handled or listed exactly once; refused ones get -32601', async () => {
    const all = [
      ...HANDLED_REQUESTS,
      ...Object.keys(HANDLED_SILENT_REQUESTS),
      ...Object.keys(KNOWN_UNHANDLED_REQUESTS),
      ...Object.keys(KNOWN_IGNORED_REQUESTS)
    ]
    expect(
      Object.keys(surface.serverRequests).filter((m) => all.filter((x) => x === m).length !== 1)
    ).toEqual([])
    expect(all.filter((m) => !(m in surface.serverRequests))).toEqual([])
    const h = await harness()
    let id = 100
    for (const m of all) {
      const before = h.sent.length
      const out = await h.feed(JSON.stringify({ id: ++id, method: m, params: { itemId: 'i' } }))
      const reply = h.sent.slice(before).find((s) => s.id === id)
      if (HANDLED_REQUESTS.has(m)) {
        expect({ m, kinds: out.map((e) => e.kind) }).toEqual({ m, kinds: ['permission-request'] })
        expect(reply).toBeUndefined()
      } else if (m in HANDLED_SILENT_REQUESTS) {
        expect({ m, kinds: out.map((e) => e.kind) }).toEqual({ m, kinds: [] })
        expect({ m, ok: reply !== undefined && 'result' in reply }).toEqual({ m, ok: true })
      } else {
        expect({ m, kinds: out.map((e) => e.kind) }).toEqual({ m, kinds: [] })
        expect({ m, error: (reply?.error as Json | undefined)?.code }).toEqual({ m, error: -32601 })
      }
    }
  })

  it('every thread item type is handled or listed exactly once, and the lists are true', async () => {
    const all = [...HANDLED_ITEMS, ...Object.keys(KNOWN_UNHANDLED_ITEMS)]
    expect(surface.threadItemTypes.filter((t) => all.filter((x) => x === t).length !== 1)).toEqual(
      []
    )
    expect(all.filter((t) => !surface.threadItemTypes.includes(t))).toEqual([])
    const wrong: string[] = []
    for (const type of surface.threadItemTypes) {
      const h = await harness()
      const started = await h.feed(
        JSON.stringify({ method: 'item/started', params: { item: { type, id: 'x' } } })
      )
      const delta =
        type === 'agentMessage' || type === 'reasoning'
          ? await h.feed(
              JSON.stringify({
                method:
                  type === 'agentMessage' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta',
                params: { itemId: 'x', delta: 'd' }
              })
            )
          : []
      const done = await h.feed(
        JSON.stringify({
          method: 'item/completed',
          params: { item: { type, id: 'x', status: 'completed' } }
        })
      )
      const n = started.length + delta.length + done.length
      const shouldShow = HANDLED_ITEMS.has(type) && !(type in HANDLED_SILENT_ITEMS)
      if (shouldShow !== n > 0) wrong.push(`${type}: ${n} events`)
    }
    expect(wrong).toEqual([])
  })
})

describe('codex protocol drift: what the driver sends', () => {
  async function sentFor(mode: string, resume: boolean): Promise<Json[]> {
    const h = await harness(
      {
        chatMode: mode,
        resume,
        sessionId: resume ? 'th' : '',
        chatCollaboration: 'plan',
        chatEffort: 'high',
        chatFastMode: true
      },
      false
    )
    await flush()
    await h.feed(JSON.stringify({ id: 1, result: {} }))
    await h.feed(
      JSON.stringify({ id: 2, result: { thread: { id: 'th' }, model: 'm', cwd: '/work' } })
    )
    h.driver.sendUserMessage('hi')
    await flush()
    await h.feed(JSON.stringify({ method: 'turn/started', params: { turn: { id: 't1' } } }))
    void h.driver.applyControl({ subtype: 'interrupt' }, 1000)
    await flush()
    return h.sent
  }

  for (const mode of chatModesForMode('codex-chat')) {
    for (const resume of [false, true]) {
      it(`${mode}${resume ? ' (resume)' : ''}: every request exists, every param is accepted, required ones are there`, async () => {
        const problems: string[] = []
        for (const msg of await sentFor(mode, resume)) {
          if (msg.method === undefined) continue
          const method = String(msg.method)
          if (msg.id === undefined) {
            if (method !== 'initialized') problems.push(`unexpected notification ${method}`)
            continue
          }
          const spec = surface.clientRequests[method]
          if (!spec) {
            problems.push(`unknown request ${method}`)
            continue
          }
          const params = (msg.params ?? {}) as Json
          for (const k of Object.keys(params))
            if (!spec.properties.includes(k)) problems.push(`${method}: unknown param ${k}`)
          for (const k of spec.required)
            if (!(k in params)) problems.push(`${method}: missing ${k}`)
          if (
            typeof params.approvalPolicy === 'string' &&
            !surface.enums.AskForApproval.includes(params.approvalPolicy)
          )
            problems.push(`${method}: approvalPolicy ${params.approvalPolicy}`)
          if (
            typeof params.sandbox === 'string' &&
            !surface.enums.SandboxMode.includes(params.sandbox)
          )
            problems.push(`${method}: sandbox ${params.sandbox}`)
          const collab = params.collaborationMode as { mode?: string } | undefined
          if (collab?.mode && !surface.enums.ModeKind.includes(collab.mode))
            problems.push(`${method}: collaborationMode ${collab.mode}`)
        }
        expect(problems).toEqual([])
      })
    }
  }

  const ALLOW: PermissionDecision = { behavior: 'allow' }
  const DENY: PermissionDecision = { behavior: 'deny', message: 'no' }
  async function decisionFor(method: string, decision: PermissionDecision): Promise<unknown> {
    const h = await harness()
    await h.feed(JSON.stringify({ id: 7, method, params: { itemId: 'i' } }))
    h.driver.respondPermission({ requestId: '7', decision })
    const sent = (h.sent.find((s) => s.id === 7)?.result as Json | undefined)?.decision
    // The surface names an object decision by its key (`{denied}`).
    return sent && typeof sent === 'object' ? `{${Object.keys(sent)[0]}}` : sent
  }

  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval'
  ]) {
    it(`${method}: allow / deny answer with decisions the schema accepts`, async () => {
      const accepted = surface.serverRequests[method].decisions
      expect(accepted).toContain(await decisionFor(method, ALLOW))
      expect(accepted).toContain(await decisionFor(method, DENY))
    })
  }

  for (const method of ['applyPatchApproval', 'execCommandApproval']) {
    it(`${method} (legacy): allow / deny answer with ReviewDecision values`, async () => {
      const accepted = surface.serverRequests[method].decisions
      const allow = await decisionFor(method, ALLOW)
      const deny = await decisionFor(method, DENY)
      expect(allow).toBeDefined()
      expect(accepted).toContain(allow)
      expect(accepted).toContain(deny)
    })
  }
})

describe('codex protocol drift: recorded runs through the driver', () => {
  for (const { recipe, file } of listCodexTranscripts()) {
    it(`${recipe}: every line parses, every method is in the surface, turns end in a result`, async () => {
      const records = readTranscript(file)
      const problems: string[] = []
      let h: Harness | null = null
      let turnsCompleted = 0
      let results = 0
      // A recorded reply names the RECORDER's request id; the driver may number its
      // requests differently (it sends requests the recorder did not, e.g.
      // model/list). Map each reply to the driver's request of the same method
      // and ordinal; a recorded reply to a request the driver never sent is dropped.
      let recordedMethods = new Map<unknown, { method: string; n: number }>()
      let recordedCounts = new Map<string, number>()
      const driverIdFor = (recordedId: unknown): unknown => {
        const rec = recordedMethods.get(recordedId)
        if (!rec || !h) return recordedId
        const sent = h.sent.filter((m) => m.method === rec.method && m.id !== undefined)
        return sent[rec.n]?.id
      }
      // Which processes resumed a thread (their first request after initialize).
      const resumed = new Set<number>()
      let proc = -1
      for (const r of records) {
        if (r.kind === 'process') proc = r.index
        if (r.kind === 'stdin' && r.line.includes('"method":"thread/resume"')) resumed.add(proc)
      }
      for (const r of records) {
        if (r.kind === 'process') {
          if (h) results += h.emitted.filter((e) => e.kind === 'result').length
          recordedMethods = new Map()
          recordedCounts = new Map()
          h = await harness({ resume: resumed.has(r.index), sessionId: '{{threadId}}' }, false)
          await flush()
          continue
        }
        if (!h) continue
        if (r.kind === 'stdin') {
          const msg = JSON.parse(r.line) as Json
          if (typeof msg.method === 'string' && msg.id !== undefined) {
            const n = recordedCounts.get(msg.method) ?? 0
            recordedCounts.set(msg.method, n + 1)
            recordedMethods.set(msg.id, { method: msg.method, n })
          }
          if (msg.method === 'turn/start') {
            const input = ((msg.params as Json).input as Array<{ text: string }>)[0]?.text ?? ''
            h.driver.sendUserMessage(input)
            await flush()
          } else if (msg.method === 'turn/interrupt') {
            void h.driver.applyControl({ subtype: 'interrupt' }, 1000).catch(() => {})
            await flush()
          } else if (msg.id !== undefined && msg.method === undefined) {
            const decision = (msg.result as Json | undefined)?.decision
            if (typeof decision === 'string')
              h.driver.respondPermission({
                requestId: String(msg.id),
                decision: decision.startsWith('accept')
                  ? { behavior: 'allow' }
                  : { behavior: 'deny', message: 'no' }
              })
          }
          continue
        }
        if (r.kind !== 'stdout') continue
        const msg = JSON.parse(r.line) as Json
        const method = msg.method as string | undefined
        if (method && msg.id === undefined && !(method in surface.serverNotifications))
          problems.push(`notification ${method} not in the surface`)
        if (method && msg.id !== undefined && !(method in surface.serverRequests))
          problems.push(`request ${method} not in the surface`)
        if (method === 'turn/completed') turnsCompleted += 1
        let line = r.line
        if (method === undefined && msg.id !== undefined) {
          const id = driverIdFor(msg.id)
          if (id === undefined) continue
          line = JSON.stringify({ ...msg, id })
        }
        const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
          problems.push(`parse error: ${a.map(String).join(' ').slice(0, 200)}`)
        })
        await h.feed(line)
        warn.mockRestore()
      }
      if (h) results += h.emitted.filter((e) => e.kind === 'result').length
      expect(problems).toEqual([])
      expect({ recipe, results }).toEqual({ recipe, results: turnsCompleted })
    })
  }
})
