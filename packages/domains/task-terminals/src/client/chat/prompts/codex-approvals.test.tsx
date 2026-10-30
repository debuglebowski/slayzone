// @vitest-environment jsdom
/**
 * Codex approvals in the prompt dock. The driver turns each Codex server request
 * into a `permission-request` (toolName = the JSON-RPC method, toolUseId = the
 * item, input = the params verbatim) and maps the answer back (contract X1 → X2):
 *   {allow} → accept · {allow, scope:'session'} → acceptForSession ·
 *   {allow, amendment:execpolicy|network} → the amendment ·
 *   {deny} → decline (the turn goes on) · {deny, interrupt} → cancel (it stops).
 * Rows follow the request's `availableDecisions` (all four when it has none).
 * Requests: what real codex 0.159.2 sent (`fake-codex/transcripts`).
 */
import type React from 'react'
import { useContext, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { recordedCodexItems, recordedCodexRequests } from '@slayzone/test-utils/fake-codex/recorded'
import { chatProviderForMode, type PermissionRequestEvent } from '@slayzone/terminal-contracts'
import type { ChatPrompt, TimelineItem } from '@slayzone/terminal/client'

vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('@slayzone/diff-view', () => ({
  DiffView: ({
    diff
  }: {
    diff: { path: string; hunks: Array<{ lines: Array<{ type: string; content: string }> }> }
  }) => (
    <div data-testid="diff-view" data-path={diff.path}>
      {diff.hunks
        .flatMap((h) => h.lines)
        .map((l, i) => (
          <div key={i} data-line={l.type}>
            {l.content}
          </div>
        ))}
    </div>
  )
}))

import { ChatViewContext, type ChatViewState } from '../ChatViewContext'
import { PromptDock, type PromptKeyHandler } from './PromptDock'
import { buildPermissionView } from './prompt-options'

const CODEX = chatProviderForMode('codex-chat')

afterEach(() => cleanup())

function codexPrompt(method: string, params: Record<string, unknown>, id = '0'): ChatPrompt {
  const req: PermissionRequestEvent = {
    kind: 'permission-request',
    requestId: id,
    toolName: method,
    toolUseId: typeof params.itemId === 'string' ? params.itemId : '',
    input: params
  }
  return {
    requestId: id,
    toolUseId: req.toolUseId,
    toolName: method,
    input: params,
    request: req,
    status: 'pending',
    decision: null,
    optionId: null
  }
}

const execRequest = () => recordedCodexRequests('approval-exec')[0]
const fileRequest = () =>
  recordedCodexRequests('approval-file').find(
    (r) => r.method === 'item/fileChange/requestApproval'
  )!

const ctx = { autoModeAvailable: false, cwd: '{{cwd}}', agent: 'Codex' }
const view = (p: ChatPrompt) => buildPermissionView(p.request, ctx)

describe('the Codex approval view', () => {
  it('a command, as 0.159.2 asks it: the command, no protocol method; rows from availableDecisions', () => {
    const req = execRequest()
    expect(req.params.availableDecisions).toEqual([
      'accept',
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'a.txt'] } },
      'cancel'
    ])
    const v = view(codexPrompt(req.method, req.params))
    expect(v.title).toBe('Run command')
    expect(JSON.stringify(v)).not.toContain('requestApproval')
    expect(v.options.map((o) => [o.id, o.label, o.decision])).toEqual([
      ['yes', 'Yes', { behavior: 'allow' }],
      [
        'yes-execpolicy',
        "Yes, and don't ask again for commands that start with `touch a.txt`",
        { behavior: 'allow', amendment: { kind: 'execpolicy', command: ['touch', 'a.txt'] } }
      ],
      [
        'cancel',
        'No, and tell Codex what to do differently (esc)',
        { behavior: 'deny', message: '', interrupt: true }
      ]
    ])
    expect(v.canAmend).toBe(false)
  })

  it('without availableDecisions (file changes, older CLIs): accept, for the session, decline, cancel', () => {
    const req = fileRequest()
    const v = view(codexPrompt(req.method, req.params))
    expect(v.title).toBe('Edit files')
    expect(v.options.map((o) => [o.id, o.decision])).toEqual([
      ['yes', { behavior: 'allow' }],
      ['yes-session', { behavior: 'allow', scope: 'session' }],
      ['no', { behavior: 'deny', message: '' }],
      ['cancel', { behavior: 'deny', message: '', interrupt: true }]
    ])
    expect(v.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for these files this session",
      'No',
      'No, and tell Codex what to do differently (esc)'
    ])
  })

  it('the legacy requests (execCommandApproval / applyPatchApproval) get the same rows', () => {
    const exec = view(
      codexPrompt('execCommandApproval', {
        conversationId: 't',
        callId: 'c1',
        command: ['/bin/zsh', '-lc', 'touch a.txt'],
        cwd: '/repo',
        reason: 'writes a file',
        parsedCmd: []
      })
    )
    expect(exec.title).toBe('Run command')
    expect(exec.decisionReason).toBe('writes a file')
    expect(exec.options.map((o) => o.id)).toEqual(['yes', 'yes-session', 'no', 'cancel'])
    const patch = view(
      codexPrompt('applyPatchApproval', {
        conversationId: 't',
        callId: 'c2',
        fileChanges: { '/repo/a.txt': { type: 'add', content: 'a\n' } },
        reason: null,
        grantRoot: null
      })
    )
    expect(patch.title).toBe('Edit files')
  })

  it('a network amendment row', () => {
    const v = view(
      codexPrompt('item/commandExecution/requestApproval', {
        itemId: 'x',
        command: 'curl example.com',
        cwd: '/repo',
        availableDecisions: [
          'accept',
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { host: 'example.com', action: 'allow' }
            }
          },
          'decline'
        ]
      })
    )
    expect(v.options[1]).toMatchObject({
      label: 'Yes, and always allow example.com',
      decision: {
        behavior: 'allow',
        amendment: { kind: 'network', host: 'example.com', action: 'allow' }
      }
    })
  })

  it('a permissions request: for this turn, for the session, or not', () => {
    const v = view(
      codexPrompt('item/permissions/requestApproval', {
        itemId: 'p',
        reason: 'needs the network',
        permissions: { network: { enabled: true } },
        cwd: '/repo'
      })
    )
    expect(v.title).toBe('Permissions')
    expect(v.decisionReason).toBe('needs the network')
    expect(v.options.map((o) => [o.label, o.decision])).toEqual([
      ['Yes, for this turn', { behavior: 'allow' }],
      ['Yes, for this session', { behavior: 'allow', scope: 'session' }],
      ['No', { behavior: 'deny', message: '' }]
    ])
  })

  it('an MCP elicitation without fields: accept, decline, cancel', () => {
    const v = view(
      codexPrompt('mcpServer/elicitation/request', {
        serverName: 'slz_echo',
        message: 'Allow echo to run?',
        requestedSchema: { type: 'object', properties: {} }
      })
    )
    expect(v.title).toBe('slz_echo asks')
    expect(v.question).toBe('Allow echo to run?')
    expect(v.options.map((o) => [o.label, o.decision])).toEqual([
      ['Accept', { behavior: 'allow', updatedInput: { content: {} } }],
      ['Decline', { behavior: 'deny', message: '' }],
      ['Cancel (esc)', { behavior: 'deny', message: '', interrupt: true }]
    ])
  })
})

let keys: { current: PromptKeyHandler | null } = { current: null }

function Dock({ overrides }: { overrides: Partial<ChatViewState> }) {
  const base = useContext(ChatViewContext)
  const keysRef = useRef<PromptKeyHandler | null>(null)
  keys = keysRef
  return (
    <ChatViewContext.Provider
      value={{
        ...base,
        provider: CODEX,
        promptCards: true,
        cwd: '{{cwd}}',
        submittingPrompts: new Set(),
        ...overrides
      }}
    >
      <PromptDock keysRef={keysRef} />
    </ChatViewContext.Provider>
  )
}

function setup(prompts: ChatPrompt[], timeline: TimelineItem[] = []) {
  const respondPermission = vi.fn(async () => true)
  const r = render(<Dock overrides={{ prompts, respondPermission, timeline }} />)
  const rerender = (next: ChatPrompt[]) =>
    r.rerender(<Dock overrides={{ prompts: next, respondPermission, timeline }} />)
  return { respondPermission, rerender }
}

function press(key: string): boolean {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  let handled = false
  act(() => {
    handled = keys.current?.(e) ?? false
  })
  return handled
}

describe('Codex approvals in the dock', () => {
  it('shows the command (not the shell wrapper) and its folder; 1 answers accept', () => {
    const req = execRequest()
    const { respondPermission } = setup([codexPrompt(req.method, req.params)])
    expect(screen.getByLabelText('Codex is waiting for your answer')).toBeTruthy()
    expect(screen.getByTestId('codex-approval-command').textContent).toBe('touch a.txt')
    expect(document.body.textContent).not.toContain('requestApproval')
    expect(press('1')).toBe(true)
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: '0',
      decision: { behavior: 'allow' },
      optionId: 'yes'
    })
  })

  it('Esc cancels (the turn stops)', () => {
    const req = execRequest()
    const { respondPermission } = setup([codexPrompt(req.method, req.params)])
    expect(press('Escape')).toBe(true)
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: '0',
      decision: { behavior: 'deny', message: '', interrupt: true },
      optionId: 'cancel'
    })
  })

  it('a file change shows the diff of the item it asks about; ↓ Enter answers for the session', () => {
    const req = fileRequest()
    const started = recordedCodexItems('approval-file', 'started', 'fileChange')[0]
    const tool: TimelineItem = {
      kind: 'tool',
      invocation: { id: started.id, name: 'codex/fileChange', input: started, status: 'pending' },
      timestamp: 1
    }
    const { respondPermission } = setup(
      [codexPrompt(req.method, req.params, String(req.id))],
      [tool]
    )
    const lines = Array.from(document.querySelectorAll('[data-line]')).map(
      (el) => `${el.getAttribute('data-line')}:${el.textContent}`
    )
    expect(lines).toEqual(['add:one.'])
    press('ArrowDown')
    press('Enter')
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: String(req.id),
      decision: { behavior: 'allow', scope: 'session' },
      optionId: 'yes-session'
    })
  })

  it('the card closes when Codex withdraws the request (serverRequest/resolved → cancelled)', () => {
    const req = execRequest()
    const p = codexPrompt(req.method, req.params)
    const { rerender } = setup([p])
    expect(screen.getByRole('button', { name: /^Yes$/ })).toBeTruthy()
    rerender([{ ...p, status: 'cancelled' }])
    expect(screen.queryByRole('button', { name: /^Yes$/ })).toBeNull()
    expect(screen.queryByLabelText('Codex is waiting for your answer')).toBeNull()
  })
})

describe('Codex questions (item/tool/requestUserInput)', () => {
  const QUESTIONS = {
    itemId: 'q-item',
    questions: [
      {
        id: 'db',
        header: 'Database',
        question: 'Which database?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'SQLite', description: 'Embedded' }
        ]
      },
      {
        id: 'token',
        header: 'Token',
        question: 'API token?',
        isOther: false,
        isSecret: true,
        options: null
      }
    ]
  }

  it('each question with its options; answers go back keyed by question id', () => {
    const { respondPermission } = setup([codexPrompt('item/tool/requestUserInput', QUESTIONS)])
    expect(document.body.textContent).toContain('Which database?')
    expect(document.body.textContent).toContain('API token?')
    const submit = screen.getByRole('button', { name: 'Submit answers' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    act(() => screen.getByRole('button', { name: /SQLite/ }).click())
    const token = screen.getByLabelText('API token?') as HTMLInputElement
    expect(token.type).toBe('password')
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(token, 's3cret')
      token.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => submit.click())
    expect(respondPermission).toHaveBeenCalledWith({
      requestId: '0',
      decision: {
        behavior: 'allow',
        updatedInput: { answers: { db: ['SQLite'], token: ['s3cret'] } }
      },
      optionId: 'submit'
    })
  })

  it('"Other" takes typed text; Skip answers nothing (the turn goes on); Esc stops the turn', () => {
    const first = setup([codexPrompt('item/tool/requestUserInput', QUESTIONS)])
    act(() => screen.getByRole('button', { name: 'Skip' }).click())
    expect(first.respondPermission).toHaveBeenCalledWith({
      requestId: '0',
      decision: { behavior: 'deny', message: '' },
      optionId: 'skip'
    })
    cleanup()
    const second = setup([codexPrompt('item/tool/requestUserInput', QUESTIONS)])
    expect(press('Escape')).toBe(true)
    expect(second.respondPermission).toHaveBeenCalledWith({
      requestId: '0',
      decision: { behavior: 'deny', message: '', interrupt: true },
      optionId: 'cancel'
    })
  })
})
