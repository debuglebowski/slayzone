/**
 * Links in an agent's answer open in-app and never navigate the app window.
 * Before: a file-path link loaded the dev server at that path in place of the
 * app, and `artifact:` / `slayzone://task/` links were blanked to `href=""`,
 * so a click reloaded the app.
 */
import type { Page } from '@playwright/test'
import { resetApp, seed } from '../fixtures/electron'
import { expect, reply, test } from '../fixtures/chat'

interface TabWindow {
  __slayzone_tabStore: {
    getState: () => { tabs: Array<{ type: string; taskId?: string }>; activeTabIndex: number }
  }
}

const activeTaskId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => {
    const s = (window as unknown as TabWindow).__slayzone_tabStore.getState()
    return s.tabs[s.activeTabIndex]?.taskId
  })

test.describe('Chat message links', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('file, artifact and task links open in-app; the window stays on the app', async ({
    chat,
    mainWindow
  }) => {
    const appUrl = mainWindow.url()
    // The links need ids that only exist once the task does: the agent answers
    // with the user's message, which carries them.
    const t = await chat.openTask({
      title: 'Chat links',
      repoFiles: { 'src/linked.ts': 'export const linkedMarker = 214\n' },
      scenario: { processes: [{ defaultTurn: reply('{{userText}}') }] }
    })
    const s = seed(t.page)
    const artifact = (await s.createArtifact({
      taskId: t.taskId,
      title: 'link-target.md',
      content: '# Linked artifact body'
    })) as { id: string }
    const self = (await t.page.evaluate(
      (id) => window.getTrpcVanillaClient().task.get.query({ id }),
      t.taskId
    )) as { project_id: string }
    const other = (await s.createTask({
      projectId: self.project_id,
      title: 'Link target task',
      status: 'todo'
    })) as { id: string }

    const answer = [
      `[Linked file](${t.cwd}/src/linked.ts:1)`,
      `[Linked artifact](artifact:${artifact.id.slice(0, 8)})`,
      `[Linked task](slayzone://task/${other.id})`
    ].join(' · ')
    await t.send(answer)
    const text = t.panel.locator('[data-chat-text]').last()
    await expect(text.getByRole('link', { name: 'Linked task' })).toBeVisible()

    // File → editor, at the cited file.
    await text.getByRole('link', { name: 'Linked file' }).click()
    await expect(
      t.page.locator('.cm-editor:visible .cm-content', { hasText: 'linkedMarker' })
    ).toBeVisible()
    expect(t.page.url()).toBe(appUrl)

    // Artifact (short id prefix) → artifacts panel, that artifact shown.
    await text.getByRole('link', { name: 'Linked artifact' }).click()
    await expect(
      t.page.locator('[data-panel-id="artifacts"]:visible').getByText('Linked artifact body')
    ).toBeVisible()
    expect(t.page.url()).toBe(appUrl)

    // Task → that task's tab.
    await text.getByRole('link', { name: 'Linked task' }).click()
    await expect.poll(() => activeTaskId(t.page)).toBe(other.id)
    expect(t.page.url()).toBe(appUrl)
  })
})
