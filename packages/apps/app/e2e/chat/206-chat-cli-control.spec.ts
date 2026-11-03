/**
 * `slay chat` / `slay agent` drive a Claude chat task end to end: the real CLI
 * against the app's hub, the scripted fake CLI as the agent. Send + wait + read,
 * a permission prompt answered from the CLI (the same wire answer the card
 * sends), and an interrupt.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { cliEnv, cliRoot, resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, reply, step, test } from '../fixtures/chat'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

const BUILD = {
  tool_name: 'Bash',
  tool_use_id: 'toolu_build',
  input: { command: 'npm run build', description: 'Build the project' }
}

test.describe('slay chat drives a chat task', () => {
  let env: Record<string, string>
  const slay = (...args: string[]) =>
    spawnSync('node', [SLAY_JS, ...args], { env, encoding: 'utf8' })

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    if (!fs.existsSync(SLAY_JS)) {
      throw new Error(`CLI not built. Run: pnpm --filter @slayzone/cli build\nExpected: ${SLAY_JS}`)
    }
    await resetApp(mainWindow)
    env = cliEnv(await cliRoot(electronApp))
    delete env.SLAYZONE_PROJECT_ID
    delete env.SLAYZONE_TASK_ID
  })

  test('send --wait, read, then the same through slay agent', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'CLI send',
      scenario: { processes: [{ defaultTurn: echoTurn() }] }
    })
    const sent = slay('chat', 'send', 'hello from the cli', '--wait', '--task', t.taskId)
    expect(sent.status, sent.stderr).toBe(0)
    expect(sent.stdout.trim()).toBe('answered')
    await expect(t.panel.getByText('echo: hello from the cli')).toBeVisible()

    const read = slay('chat', 'read', '--task', t.taskId)
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('> hello from the cli')
    expect(read.stdout).toContain('echo: hello from the cli')

    const viaAgent = slay('agent', 'send', 'and again', '--wait', '--task', t.taskId)
    expect(viaAgent.status, viaAgent.stderr).toBe(0)
    await expect(t.panel.getByText('echo: and again')).toBeVisible()
  })

  test('a permission prompt: wait exits 3, prompts lists it, allow answers it', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'CLI prompt',
      scenario: {
        processes: [
          {
            turns: [
              [
                step.emit(
                  ev.init(),
                  ev.toolUse({ id: BUILD.tool_use_id, name: BUILD.tool_name, input: BUILD.input })
                ),
                step.request(BUILD, {
                  allow: [
                    step.emit(
                      ev.toolResult({ toolUseId: BUILD.tool_use_id, content: 'built' }),
                      ev.text('Build done.'),
                      ev.result({ text: 'Build done.' })
                    )
                  ],
                  deny: reply('Not building.')
                })
              ]
            ]
          }
        ]
      }
    })
    const sent = slay('chat', 'send', 'build it', '--wait', '--task', t.taskId)
    expect(sent.status, `${sent.stdout}\n${sent.stderr}`).toBe(3)

    const listed = slay('chat', 'prompts', '--json', '--task', t.taskId)
    expect(listed.status, listed.stderr).toBe(0)
    const prompts = JSON.parse(listed.stdout) as Array<{
      requestId: string
      kind: string
      toolName: string
    }>
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ kind: 'permission', toolName: 'Bash' })

    const allowed = slay('chat', 'allow', prompts[0].requestId.slice(0, 6), '--task', t.taskId)
    expect(allowed.status, allowed.stderr).toBe(0)
    const run = await t.run(0, (r) => r.decisions().length === 1)
    expect(run.decisions()[0]).toMatchObject({ toolName: 'Bash', behavior: 'allow' })

    const settled = slay('chat', 'wait', '--task', t.taskId, '--timeout', '15000')
    expect(settled.status, settled.stderr).toBe(0)
    await expect(t.panel.getByText('Build done.')).toBeVisible()
  })

  test('interrupt stops a running turn and keeps the process', async ({ chat }) => {
    const t = await chat.openTask({
      title: 'CLI interrupt',
      scenario: {
        processes: [
          {
            turns: [[step.emit(ev.init(), ev.text('working on it')), step.hang()]],
            defaultTurn: echoTurn()
          }
        ]
      }
    })
    expect(slay('chat', 'send', 'a long job', '--task', t.taskId).status).toBe(0)
    await expect(t.panel.getByText('working on it')).toBeVisible()

    const stopped = slay('chat', 'interrupt', '--task', t.taskId)
    expect(stopped.status, stopped.stderr).toBe(0)
    expect(stopped.stdout.trim()).toBe('interrupted')
    const run = await t.run(0, (r) => r.controlRequests('interrupt').length === 1)
    expect(run.signals()).toEqual([])
  })
})
