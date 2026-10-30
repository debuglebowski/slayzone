import type { HubClient } from '../hub-board'
import { trpcTest } from '../testing'
import {
  interruptAgent,
  resetAgent,
  restartAgent,
  startAgent,
  stopAgent,
  switchAgentMode
} from './lifecycle'

const STARTED = {
  sessionId: 't:t',
  tabId: 't',
  mode: 'claude-code',
  kind: 'pty',
  cwd: '/repo',
  state: 'starting',
  started: true
}

/** A hub client that records every call (path + input) in order. */
function hub(answers: Record<string, (input: unknown) => unknown> = {}) {
  const calls: Array<[string, unknown]> = []
  const paths = [
    'task.startMainAgent',
    'task.resetConversation',
    'task.update',
    'pty.kill',
    'pty.write',
    'pty.interrupt',
    'chat.kill',
    'chat.reset',
    'chat.getInfo'
  ]
  const procedures = Object.fromEntries(
    paths.map((path) => [
      path,
      (input: unknown) => {
        calls.push([path, input])
        if (answers[path]) return answers[path](input)
        if (path === 'task.startMainAgent') return STARTED
        return null
      }
    ])
  )
  const client = trpcTest({ procedures }).trpcClient as unknown as HubClient
  return { client, calls }
}

const terminal = { taskId: 't', tabId: 't', mode: 'claude-code' }
const chat = { taskId: 't', tabId: 't', mode: 'claude-chat' }

describe('agent lifecycle', () => {
  it('starts a task’s main agent through the hub (never pty.create)', async () => {
    const { client, calls } = hub()
    await expect(startAgent(client, 't')).resolves.toMatchObject({ started: true })
    expect(calls).toEqual([['task.startMainAgent', { taskId: 't' }]])
  })

  it('stops a terminal agent with pty.kill, a chat agent with chat.kill', async () => {
    const a = hub()
    await stopAgent(a.client, terminal)
    expect(a.calls).toEqual([['pty.kill', { sessionId: 't:t' }]])
    const b = hub()
    await stopAgent(b.client, chat)
    expect(b.calls).toEqual([['chat.kill', { tabId: 't' }]])
  })

  it('restarts: stop, then start again (the conversation resumes)', async () => {
    const { client, calls } = hub()
    await restartAgent(client, terminal)
    expect(calls).toEqual([
      ['pty.kill', { sessionId: 't:t' }],
      ['task.startMainAgent', { taskId: 't' }]
    ])
  })

  it('resets a terminal agent: stop, forget the conversation, start fresh', async () => {
    const { client, calls } = hub()
    await resetAgent(client, terminal)
    expect(calls).toEqual([
      ['pty.kill', { sessionId: 't:t' }],
      ['task.resetConversation', { id: 't', mode: 'claude-code' }],
      ['task.startMainAgent', { taskId: 't' }]
    ])
  })

  it('resets a chat agent with chat.reset in the folder its session runs in', async () => {
    const { client, calls } = hub({ 'chat.getInfo': () => ({ cwd: '/repo/wt' }) })
    await resetAgent(client, chat)
    expect(calls).toEqual([
      ['chat.getInfo', { tabId: 't' }],
      [
        'chat.reset',
        {
          tabId: 't',
          taskId: 't',
          mode: 'claude-chat',
          cwd: '/repo/wt',
          providerFlagsOverride: null
        }
      ]
    ])
  })

  it('resets a chat agent with no session yet: the hub starts it (resolving its folder) first', async () => {
    const { client, calls } = hub({
      'chat.getInfo': () => null,
      'task.startMainAgent': () => ({ ...STARTED, kind: 'chat', cwd: '/repo' })
    })
    await resetAgent(client, chat)
    expect(calls.map(([path]) => path)).toEqual([
      'chat.getInfo',
      'task.startMainAgent',
      'chat.reset'
    ])
    expect(calls[2][1]).toMatchObject({ cwd: '/repo' })
  })

  it('interrupts a terminal agent the way desktop does: Esc to the agent + the state flip', async () => {
    const { client, calls } = hub()
    await interruptAgent(client, terminal)
    expect(calls).toEqual([
      ['pty.write', { sessionId: 't:t', data: '\x1b' }],
      ['pty.interrupt', { sessionId: 't:t' }]
    ])
  })

  it('switches mode as desktop does: stop, new mode with every conversation id cleared, start', async () => {
    const { client, calls } = hub()
    await switchAgentMode(
      client,
      {
        id: 't',
        terminal_mode: 'claude-code',
        provider_config: { 'claude-code': { conversationId: 'c1', flags: '--x' } }
      },
      'codex'
    )
    expect(calls).toEqual([
      ['pty.kill', { sessionId: 't:t' }],
      [
        'task.update',
        {
          id: 't',
          terminalMode: 'codex',
          providerConfig: { 'claude-code': { conversationId: null } }
        }
      ],
      ['task.startMainAgent', { taskId: 't' }]
    ])
  })

  it('switching away from a chat mode stops the chat agent', async () => {
    const { client, calls } = hub()
    await switchAgentMode(
      client,
      { id: 't', terminal_mode: 'claude-chat', provider_config: {} },
      'claude-code'
    )
    expect(calls[0]).toEqual(['chat.kill', { tabId: 't' }])
  })
})
