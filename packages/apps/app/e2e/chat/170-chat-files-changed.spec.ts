/**
 * Claude Code chat: files changed (chat E, plan 4.3). A turn that changed files
 * ends with "N files changed"; a file in it shows the card that changed it
 * (scrolled to and opened); the panel shows every file of the conversation with
 * ONE combined diff (before the first edit → after the last). Shell commands are
 * named, not guessed. Survives a reload (the row is rebuilt from the saved
 * events). In a narrow pane the panel covers the chat instead of squeezing it.
 * Against the scripted fake CLI.
 */
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
    ev.text(LONG),
    ev.result({ text: 'done' })
  )
]

test.describe('Chat files changed', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('summary row, card reveal, combined diff, shell note, reload, narrow overlay', async ({
    chat
  }) => {
    const t = await chat.openTask({
      title: 'Files changed',
      scenario: { processes: [{ turns: [CHANGE_TURN], defaultTurn: echoTurn() }] }
    })
    await t.send('change the files')
    await expect(t.panel.getByText('Paragraph 59 of the summary.')).toBeVisible()

    // The turn's summary: two files (a.ts twice, new.ts created), one shell command.
    const summary = t.panel.getByTestId('chat-files-changed')
    await expect(summary).toContainText('2 files changed')
    await summary.getByTestId('chat-files-changed-toggle').click()
    const files = summary.getByTestId('chat-files-changed-file')
    await expect(files).toHaveCount(2)
    await expect(files.nth(0)).toContainText('src/app.ts')
    await expect(files.nth(0)).toContainText('2 edits')
    await expect(files.nth(1)).toContainText('src/new.ts')
    await expect(files.nth(1)).toContainText('New')
    await expect(summary.getByTestId('chat-files-changed-shell-note')).toContainText(
      '1 shell command'
    )

    // A file shows the card of its first edit: scrolled to, and opened.
    const card = t.panel.locator('[data-item-key="tool:toolu_e1"]')
    await t.panel.getByText('Paragraph 30 of the summary.').click({ button: 'right' })
    await t.page.getByText('Collapse all expanded blocks').click()
    await expect(card.getByText('const b = 22').first()).toBeHidden()
    await expect(card).not.toBeInViewport()
    // "Collapse all" folded the summary too.
    await expect(files).toHaveCount(0)
    await summary.getByTestId('chat-files-changed-toggle').click()
    await files.nth(0).click()
    await expect(card).toBeInViewport()
    await expect(card.getByText('const b = 22').first()).toBeVisible()

    // The panel: one combined diff for app.ts (both edits), the shell note.
    await t.panel.getByTestId('chat-files-changed-button').click()
    const panel = t.page.getByTestId('chat-files-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('chat-files-panel-shell-note')).toContainText(
      "can't be seen here"
    )
    const app = panel.locator('[data-testid="chat-files-panel-file"][data-path$="/src/app.ts"]')
    await expect(app).toContainText('2 edits')
    await expect(app.getByText('const b = 22').first()).toBeVisible()
    await expect(app.getByText('const c = 33').first()).toBeVisible()
    await expect(app.getByText('const c = 3', { exact: true }).first()).toBeVisible()
    const created = panel.locator('[data-testid="chat-files-panel-file"][data-path$="/src/new.ts"]')
    await expect(created).toContainText('New')
    await expect(created.getByText('export const x = 1').first()).toBeVisible()

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
    await expect(t.panel.getByTestId('chat-files-changed')).toContainText('2 files changed')
    await expect(t.panel.getByTestId('chat-files-changed-button')).toContainText('2 files')
  })
})
