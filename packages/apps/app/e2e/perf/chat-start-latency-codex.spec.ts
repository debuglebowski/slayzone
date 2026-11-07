/**
 * Codex chat start latency, the twin of chat-start-latency.spec.ts (Claude):
 * cold = the first chat after app start, warm = the ones after it. Lazy spawn:
 * open a new chat task, type, send. Probes: fixtures/chat-start-measure.ts.
 */
import { createIsolatedGitRepo, resetApp } from '../fixtures/electron'
import { chatDb } from '../fixtures/chat-task-core'
import { codexReply, test } from '../fixtures/chat-codex'
import {
  record,
  seedBusyWorkspace,
  seenAt,
  sendTimed,
  watchTexts
} from '../fixtures/chat-start-measure'

const WARM_RUNS = Number(process.env.CHAT_START_WARM ?? 4)
const SKILLS = Number(process.env.CHAT_START_SKILLS ?? 0)

test.describe('chat start latency (Codex)', () => {
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
    test(`${path} #${i}: send on a new chat → agent → first reply`, async ({ codexChat }) => {
      test.setTimeout(90_000)
      const answer = `codexreply${i}ok`
      const prompt = `codex prompt number ${i}`
      const open0 = Date.now()
      const t = await codexChat.openTask({
        title: `Codex chat start ${i}`,
        spawn: 'on-send',
        scenario: { processes: [{ turns: [codexReply(answer)] }] }
      })
      await watchTexts(t.page, [prompt, answer])
      const t0 = await sendTimed(t.composer, prompt)
      const openMs = t0 - open0
      const shown = await seenAt(t.page, prompt)
      const replied = await seenAt(t.page, answer)
      const run = await t.run(0, (r) => r.entries.some((e) => e.kind === 'turn'))
      const turn = run.entries.find((e) => e.kind === 'turn')
      record({
        provider: 'codex',
        path,
        openMs,
        userShownMs: shown - t0,
        spawnMs: run.startedAt - t0,
        promptMs: run.startedAt + (turn?.t ?? Number.NaN) - t0,
        replyShownMs: replied - t0
      })
    })
  }
})
