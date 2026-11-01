import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetApp } from '../fixtures/electron'
import { echoTurn, ev, expect, step, test } from '../fixtures/chat'

const V1 = 'const a = 1\nconst b = 2\nconst c = 3\n'
const V2 = 'const a = 1\nconst b = 22\nconst c = 3\n'

const edit = (id: string, before: string, from: string, to: string) => [
  ev.toolUse({
    id,
    name: 'Edit',
    input: { file_path: '{{cwd}}/src/app.ts', old_string: from, new_string: to }
  }),
  ev.toolResult({
    toolUseId: id,
    content: 'The file has been updated.',
    structured: {
      filePath: '{{cwd}}/src/app.ts',
      oldString: from,
      newString: to,
      originalFile: before,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: before
            .trimEnd()
            .split('\n')
            .flatMap((l) => (l === from ? [`-${from}`, `+${to}`] : [` ${l}`]))
        }
      ],
      userModified: false,
      replaceAll: false
    }
  })
]

/** A long reply: the turn's first card ends up far above the bottom. */
const LONG = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the summary.`).join('\n\n')

const CHANGE_TURN = [
  step.emit(
    ev.init(),
    ...edit('toolu_e1', V1, 'const b = 2', 'const b = 22'),
    ev.toolUse({ id: 'toolu_b1', name: 'Bash', input: { command: 'touch scratch.txt' } }),
    ev.toolResult({ toolUseId: 'toolu_b1', content: '', structured: { stdout: '', stderr: '' } }),
    ...edit('toolu_e2', V2, 'const c = 3', 'const c = 33'),
    ev.toolUse({
      id: 'toolu_w1',
      name: 'Write',
      input: { file_path: '{{cwd}}/src/new.ts', content: 'export const x = 1\n' }
    }),
    ev.toolResult({
      toolUseId: 'toolu_w1',
      content: 'File created successfully',
      structured: {
        type: 'create',
        filePath: '{{cwd}}/src/new.ts',
        content: 'export const x = 1\n',
        structuredPatch: [],
        originalFile: null
      }
    }),
    ev.text(LONG)
  ),
  step.hang()
]

test.describe('Chat files changed', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('net summary, tool reveal, saved diff, shell changes, reload, narrow overlay', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Files changed',
      repoFiles: { 'src/app.ts': V1 },
      scenario: { processes: [{ turns: [CHANGE_TURN], defaultTurn: echoTurn() }] }
    })
    await t.send('change the files')
    await expect(t.panel.getByText('Paragraph 59 of the summary.')).toBeVisible()

    // Real writes match the scripted tools, plus a shell-only file.
    writeFileSync(join(t.cwd, 'src/app.ts'), V2.replace('const c = 3', 'const c = 33'))
    writeFileSync(join(t.cwd, 'src/new.ts'), 'export const x = 1\n')
    writeFileSync(join(t.cwd, 'scratch.txt'), 'shell output\n')
    await t.stopButton.click()
    const summary = t.panel.getByTestId('chat-files-changed')
    await expect(summary).toHaveCount(1)
    await expect(summary).toContainText('3 files changed')
    await summary.getByRole('button', { name: /3 files changed/ }).click()
    const panel = t.page.getByTestId('chat-files-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('chat-files-panel-file')).toHaveCount(3)
    await expect(panel.getByText('Net changes during this turn', { exact: false })).toBeVisible()
    const app = panel.locator('[data-testid="chat-files-panel-file"][data-path="src/app.ts"]')
    await app.getByRole('button', { name: /src\/app.ts/ }).click()
    await expect(app.getByText('const b = 22').first()).toBeVisible()
    await expect(app.getByText('const c = 33').first()).toBeVisible()
    await expect(app.getByText('const c = 3', { exact: true }).first()).toBeVisible()
    // Known file-tool attribution still reveals its first edit.
    await app.getByRole('button', { name: 'View recorded edits' }).click()
    const card = t.panel.getByRole('button', { name: /^Edit .*src\/app.ts/ }).first()
    await expect(card).toBeInViewport()
    await expect(card).toHaveAttribute('aria-expanded', 'true')
    await expect(
      t.panel.getByTestId('chat-timeline-scroller').getByText('const b = 22').first()
    ).toBeVisible()
    const created = panel.locator('[data-testid="chat-files-panel-file"][data-path="src/new.ts"]')
    await created.getByRole('button', { name: /src\/new.ts/ }).click()
    await expect(created.getByText('export const x = 1').first()).toBeVisible()
    await expect(panel.getByRole('button', { name: /scratch.txt/ })).toBeVisible()

    // Wide pane: beside the chat. Narrow pane: over it.
    expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe('static')
    await panel.evaluate((el) => {
      ;(el.parentElement as HTMLElement).style.width = '600px'
    })
    await expect.poll(() => panel.evaluate((el) => getComputedStyle(el).position)).toBe('absolute')
    await panel.evaluate((el) => {
      ;(el.parentElement as HTMLElement).style.width = ''
    })
    await panel.press('Escape')
    await expect(panel).toBeHidden()

    // A reload rebuilds the row from the saved events.
    await t.reload()
    await expect(t.panel.getByTestId('chat-files-changed')).toContainText('3 files changed')
    await expect(t.panel.getByTestId('chat-files-changed-button')).toContainText('Files changed')
  })
})
