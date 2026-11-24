/**
 * fu-2: a computer's chat store gives its free space back when the user asks
 * (Settings → Backup → Chat storage → Reclaim). The rebuild runs on the computer in
 * its worker (the PACKAGED computer bundle: its eval worker loads better-sqlite3
 * there), swaps the file in, and the chat stays readable and writable.
 */
import { clickSettings, resetApp } from '../fixtures/electron'
import { expect, savedTurnResult, test } from '../fixtures/chat'

const MiB = 1024 * 1024

test('chat storage: free space is reclaimed from Settings and the chat stays readable', async ({
  chat,
  mainWindow
}) => {
  test.setTimeout(240_000)
  await resetApp(mainWindow)
  const marker = `kept-${Date.now()}`
  const t = await chat.openTask({
    title: 'Chat storage compaction',
    spawn: 'on-send',
    scenario: { processes: [] },
    // A finished turn: a saved answer shows as one (not as a turn still running).
    seedEvents: [
      { kind: 'assistant-text', messageId: 'kept', text: marker },
      savedTurnResult(marker)
    ]
  })
  await expect(t.panel.getByText(marker, { exact: true })).toBeVisible()

  // ~320 MB of history saved and deleted: free pages worth offering.
  const before = (await t.page.evaluate(
    (tabId) =>
      window.getTrpcVanillaClient().chat.testStorageSlack.mutate({ tabId, megabytes: 320 }),
    t.tabId
  )) as { supported: boolean; worthIt: boolean; fileBytes: number; autoVacuum: string }
  expect(before).toMatchObject({ supported: true, worthIt: true, autoVacuum: 'none' })

  await clickSettings(mainWindow)
  const dialog = mainWindow.getByTestId('settings-view').first()
  // Backups are the default hub's: its page, Backups tab.
  await dialog.getByTestId('settings-nav-hub').first().click()
  await dialog.getByTestId('hub-tab-backups').click()
  const reclaim = dialog.getByRole('button', { name: /^Reclaim / })
  await expect(reclaim).toBeEnabled({ timeout: 30_000 })
  await reclaim.click()
  await expect(dialog.getByText(/^Reclaimed /)).toBeVisible({ timeout: 180_000 })

  const after = (await t.page.evaluate(async () => {
    const client = window.getTrpcVanillaClient()
    const [pc] = await client.computers.list.query()
    return client.chat.storage.status.query({ computerId: pc.id })
  })) as { supported: boolean; worthIt: boolean; fileBytes: number; autoVacuum: string }
  expect(after).toMatchObject({ supported: true, autoVacuum: 'incremental', worthIt: false })
  expect(after.fileBytes).toBeLessThan(before.fileBytes - 200 * MiB)

  // The chat reads from the new file, and takes new history.
  await mainWindow.keyboard.press('Escape')
  const events = (await t.page.evaluate(
    (tabId) =>
      window.getTrpcVanillaClient().chat.testReadEvents.query({ tabId, afterSeq: -1, limit: 10 }),
    t.tabId
  )) as Array<{ event: { text?: string } }>
  expect(events.map((e) => e.event.text)).toContain(marker)
  await t.page.evaluate(
    (tabId) =>
      window.getTrpcVanillaClient().chat.testSeedEvents.mutate({
        tabId,
        fromSeq: 2,
        events: [{ kind: 'assistant-text', messageId: 'after', text: 'written after the swap' }]
      }),
    t.tabId
  )
  const next = (await t.page.evaluate(
    (tabId) =>
      window.getTrpcVanillaClient().chat.testReadEvents.query({ tabId, afterSeq: -1, limit: 10 }),
    t.tabId
  )) as Array<{ event: { text?: string } }>
  expect(next.map((e) => e.event.text)).toContain('written after the swap')
})
