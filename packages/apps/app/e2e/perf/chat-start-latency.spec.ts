/**
 * Claude Code chat start latency (cold: the first chat after app start; warm:
 * the ones after it), against the scripted fake CLI. Lazy spawn: open a new chat
 * task, type, send — the first send starts the agent. Probes:
 * fixtures/chat-start-measure.ts. Codex twin: chat-start-latency-codex.spec.ts.
 *
 * Wall-clock: prints samples (and appends them to CHAT_START_OUT); run alone.
 */
import { createIsolatedGitRepo, resetApp } from '../fixtures/electron'
import { chatDb } from '../fixtures/chat-task-core'
import { reply, test } from '../fixtures/chat'
import {
  record,
  seedBusyWorkspace,
  seenAt,
  sendTimed,
  watchTexts
} from '../fixtures/chat-start-measure'

const WARM_RUNS = Number(process.env.CHAT_START_WARM ?? 4)
const SKILLS = Number(process.env.CHAT_START_SKILLS ?? 0)

test.describe('chat start latency (Claude)', () => {
  test.beforeAll(async ({ mainWindow, electronApp }) => {
    test.setTimeout(180_000)
    await resetApp(mainWindow)
    await seedBusyWorkspace(
      mainWindow,
      chatDb(electronApp),
      createIsolatedGitRepo(`busy-${Date.now()}`),
      SKILLS
    )
  })

  for (let i = 0; i <= WARM_RUNS; i++) {
    const path = i === 0 ? 'cold' : 'warm'
    test(`${path} #${i}: send on a new chat → agent → first reply`, async ({ chat }) => {
      test.setTimeout(90_000)
      const answer = `reply number ${i} ok`
      const prompt = `prompt number ${i}`
      const open0 = Date.now()
      const t = await chat.openTask({
        title: `Chat start ${i}`,
        spawn: 'on-send',
        scenario: { processes: [{ turns: [reply(answer)] }] }
      })
      await watchTexts(t.page, [prompt, answer])
      const t0 = await sendTimed(t.composer, prompt)
      const openMs = t0 - open0
      const shown = await seenAt(t.page, prompt)
      const replied = await seenAt(t.page, answer)
      const run = await t.run(0, (r) => r.userMessages().includes(prompt))
      const promptEntry = run.entries.find(
        (e) => e.kind === 'stdin' && (e.msg as { type?: string })?.type === 'user'
      )
      record({
        provider: 'claude',
        path,
        openMs,
        userShownMs: shown - t0,
        spawnMs: run.startedAt - t0,
        promptMs: run.startedAt + (promptEntry?.t ?? Number.NaN) - t0,
        replyShownMs: replied - t0
      })
    })
  }
})
