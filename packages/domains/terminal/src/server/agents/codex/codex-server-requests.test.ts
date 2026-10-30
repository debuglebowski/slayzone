/**
 * What the Codex driver does with the app-server's requests to the client
 * (codex-cli 0.159.2 schema): every approval kind becomes a `permission-request`,
 * the user's answer goes back in that request's own vocabulary (v2 decisions,
 * the legacy ReviewDecision words, permission grants, question answers, MCP
 * elicitation actions), and a request the server withdrew closes its card.
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent, PermissionDecision } from '@slayzone/terminal-contracts'
import type { ChatDriverContext, ChatSessionDriver } from '../types'
import { codexChatBackend } from './codex-chat-session'

type Json = Record<string, unknown>
type Driver = ChatSessionDriver & Required<Pick<ChatSessionDriver, 'respondPermission'>>

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

interface H {
  driver: Driver
  sent: Json[]
  emitted: AgentEvent[]
  feed(msg: Json): Promise<AgentEvent[]>
  reply(id: number): Json | undefined
}

async function harness(ctx: Partial<ChatDriverContext> = {}): Promise<H> {
  const sent: Json[] = []
  const emitted: AgentEvent[] = []
  const driver = codexChatBackend.createDriver() as Driver
  void driver.start({
    write: (line) => sent.push(JSON.parse(line) as Json),
    emit: (e) => emitted.push(e),
    cwd: '/work',
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: 'approval-required',
    chatCollaboration: null,
    chatFastMode: false,
    ...ctx
  })
  const h: H = {
    driver,
    sent,
    emitted,
    async feed(msg) {
      const before = emitted.length
      driver.handleLine(JSON.stringify(msg))
      await flush()
      return emitted.slice(before)
    },
    reply: (id) => sent.find((s) => s.id === id && s.method === undefined)
  }
  await flush()
  await h.feed({ id: 1, result: { userAgent: 'slayzone/0.159.2 (x)' } })
  await h.feed({ id: 2, result: { thread: { id: 'th' }, model: 'm', cwd: '/work' } })
  return h
}

/** Answer request `id` (method + params) with `decision`; the reply's result. */
async function answer(
  method: string,
  params: Json,
  decision: PermissionDecision
): Promise<{ result: unknown; request: AgentEvent | undefined }> {
  const h = await harness()
  const out = await h.feed({ id: 9, method, params })
  const request = out.find((e) => e.kind === 'permission-request')
  expect(h.driver.respondPermission({ requestId: '9', decision })).toBe(true)
  return { result: h.reply(9)?.result, request }
}

const ALLOW: PermissionDecision = { behavior: 'allow' }
const SESSION: PermissionDecision = { behavior: 'allow', scope: 'session' }
const DENY: PermissionDecision = { behavior: 'deny', message: 'no' }
const STOP: PermissionDecision = { behavior: 'deny', message: 'no', interrupt: true }
const EXECPOLICY: PermissionDecision = {
  behavior: 'allow',
  amendment: { kind: 'execpolicy', command: ['npm', 'test'] }
}
const NETWORK: PermissionDecision = {
  behavior: 'allow',
  amendment: { kind: 'network', host: 'registry.npmjs.org', action: 'allow' }
}

const CMD = {
  threadId: 'th',
  turnId: 't1',
  itemId: 'exec-1',
  startedAtMs: 1,
  command: 'npm test',
  cwd: '/work',
  reason: 'needs network'
}

describe('command approval (item/commandExecution/requestApproval)', () => {
  const M = 'item/commandExecution/requestApproval'
  it.each([
    ['allow', ALLOW, 'accept'],
    ['allow for the session', SESSION, 'acceptForSession'],
    ['deny (the turn goes on)', DENY, 'decline'],
    ['deny + stop', STOP, 'cancel'],
    [
      'allow + exec-policy rule',
      EXECPOLICY,
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }
    ],
    [
      'allow + network rule',
      NETWORK,
      {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host: 'registry.npmjs.org', action: 'allow' }
        }
      }
    ]
  ])('%s', async (_name, decision, expected) => {
    const { result } = await answer(M, CMD, decision)
    expect(result).toEqual({ decision: expected })
  })

  it('the card says what is asked: the command, its folder, why', async () => {
    const { request } = await answer(M, CMD, ALLOW)
    expect(request).toMatchObject({
      kind: 'permission-request',
      requestId: '9',
      toolName: M,
      toolUseId: 'exec-1',
      input: CMD,
      displayName: 'Run command',
      description: 'npm test',
      decisionReason: 'needs network'
    })
  })
})

describe('file change approval (item/fileChange/requestApproval)', () => {
  const M = 'item/fileChange/requestApproval'
  const P = { threadId: 'th', turnId: 't1', itemId: 'patch-1', startedAtMs: 1, reason: null }
  it.each([
    ['allow', ALLOW, 'accept'],
    ['allow for the session', SESSION, 'acceptForSession'],
    ['deny', DENY, 'decline'],
    ['deny + stop', STOP, 'cancel']
  ])('%s', async (_name, decision, expected) => {
    expect((await answer(M, P, decision)).result).toEqual({ decision: expected })
  })
})

describe('legacy approvals answer with ReviewDecision words', () => {
  const EXEC = {
    conversationId: 'th',
    callId: 'call-1',
    command: ['npm', 'test'],
    cwd: '/work',
    parsedCmd: []
  }
  const PATCH = { conversationId: 'th', callId: 'call-2', fileChanges: {} }
  it.each([
    ['allow', ALLOW, 'approved'],
    ['allow for the session', SESSION, 'approved_for_session'],
    ['deny', DENY, { denied: { rejection: 'no' } }],
    ['deny + stop', STOP, 'abort'],
    [
      'allow + exec-policy rule',
      EXECPOLICY,
      { approved_execpolicy_amendment: { proposed_execpolicy_amendment: ['npm', 'test'] } }
    ],
    [
      'allow + network rule',
      NETWORK,
      {
        network_policy_amendment: {
          network_policy_amendment: { host: 'registry.npmjs.org', action: 'allow' }
        }
      }
    ]
  ])('execCommandApproval: %s', async (_name, decision, expected) => {
    expect((await answer('execCommandApproval', EXEC, decision)).result).toEqual({
      decision: expected
    })
  })

  it('applyPatchApproval: allow / deny; the card is keyed by the call id', async () => {
    const allowed = await answer('applyPatchApproval', PATCH, ALLOW)
    expect(allowed.result).toEqual({ decision: 'approved' })
    expect(allowed.request).toMatchObject({ toolUseId: 'call-2' })
    expect((await answer('applyPatchApproval', PATCH, DENY)).result).toEqual({
      decision: { denied: { rejection: 'no' } }
    })
  })

  it('execCommandApproval shows the command joined', async () => {
    const { request } = await answer('execCommandApproval', EXEC, ALLOW)
    expect(request).toMatchObject({ toolUseId: 'call-1', description: 'npm test' })
  })
})

describe('extra permissions (item/permissions/requestApproval)', () => {
  const M = 'item/permissions/requestApproval'
  const PERMS = { network: { enabled: true } }
  const P = {
    threadId: 'th',
    turnId: 't1',
    itemId: 'perm-1',
    startedAtMs: 1,
    cwd: '/work',
    permissions: PERMS,
    reason: 'download'
  }
  it('allow grants what was asked for the turn; for the session with scope', async () => {
    expect((await answer(M, P, ALLOW)).result).toEqual({ permissions: PERMS, scope: 'turn' })
    expect((await answer(M, P, SESSION)).result).toEqual({ permissions: PERMS, scope: 'session' })
  })
  it('deny grants nothing', async () => {
    expect((await answer(M, P, DENY)).result).toEqual({ permissions: {}, scope: 'turn' })
  })
})

describe('questions (item/tool/requestUserInput)', () => {
  const M = 'item/tool/requestUserInput'
  const P = {
    threadId: 'th',
    turnId: 't1',
    itemId: 'q-item',
    isBlocking: true,
    questions: [
      {
        id: 'q1',
        header: 'Scope',
        question: 'Which part?',
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' }
        ]
      }
    ]
  }
  it('the answers go back keyed by question id', async () => {
    const { result, request } = await answer(M, P, {
      behavior: 'allow',
      updatedInput: { answers: { q1: ['B'] } }
    })
    expect(request).toMatchObject({ toolName: M, toolUseId: 'q-item', input: P })
    expect(result).toEqual({ answers: { q1: { answers: ['B'] } } })
  })
  it('declining answers nothing (the turn goes on)', async () => {
    expect((await answer(M, P, DENY)).result).toEqual({ answers: {} })
  })
})

describe('MCP elicitation (mcpServer/elicitation/request)', () => {
  const M = 'mcpServer/elicitation/request'
  const P = { threadId: 'th', turnId: 't1', serverName: 'docs', mode: 'form', message: 'Token?' }
  it.each([
    [
      'accept with the form values',
      { behavior: 'allow', updatedInput: { content: { token: 'x' } } },
      { action: 'accept', content: { token: 'x' } }
    ],
    ['accept, no fields', ALLOW, { action: 'accept', content: {} }],
    ['decline', DENY, { action: 'decline', content: null }],
    ['cancel', STOP, { action: 'cancel', content: null }]
  ] as Array<[string, PermissionDecision, Json]>)('%s', async (_name, decision, expected) => {
    expect((await answer(M, P, decision)).result).toEqual(expected)
  })
})

describe('requests with no card', () => {
  it('currentTime/read is answered at once with the time', async () => {
    const h = await harness()
    const out = await h.feed({ id: 5, method: 'currentTime/read', params: { threadId: 'th' } })
    expect(out).toEqual([])
    const reply = h.reply(5)?.result as { currentTimeAt: number }
    expect(Math.abs(reply.currentTimeAt - Date.now() / 1000)).toBeLessThan(5)
  })
  it('requests chat cannot serve get a JSON-RPC error, not a card', async () => {
    const h = await harness()
    for (const [i, m] of ['item/tool/call', 'account/chatgptAuthTokens/refresh'].entries()) {
      const out = await h.feed({ id: 20 + i, method: m, params: {} })
      expect(out).toEqual([])
      expect((h.reply(20 + i)?.error as Json | undefined)?.code).toBe(-32601)
    }
  })
})

describe('a request the server withdrew (serverRequest/resolved)', () => {
  it('a pending card closes: permission-cancelled, and a late answer is refused', async () => {
    const h = await harness()
    await h.feed({ id: 0, method: 'item/commandExecution/requestApproval', params: CMD })
    const out = await h.feed({
      method: 'serverRequest/resolved',
      params: { threadId: 'th', requestId: 0 }
    })
    expect(out).toEqual([{ kind: 'permission-cancelled', requestId: '0' }])
    expect(h.driver.respondPermission({ requestId: '0', decision: ALLOW })).toBe(false)
  })
  it('the echo after our own answer closes nothing', async () => {
    const h = await harness()
    await h.feed({ id: 0, method: 'item/commandExecution/requestApproval', params: CMD })
    h.driver.respondPermission({ requestId: '0', decision: ALLOW })
    const out = await h.feed({
      method: 'serverRequest/resolved',
      params: { threadId: 'th', requestId: 0 }
    })
    expect(out).toEqual([])
  })
})
