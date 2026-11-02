import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cliRoot, supervisedHubRoot, resetApp } from '../fixtures/electron'
import { expect, test } from '../fixtures/chat'

function matchingFiles(root: string, marker: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...matchingFiles(file, marker))
    else if (entry.isFile()) {
      try {
        if (fs.readFileSync(file).includes(Buffer.from(marker))) found.push(file)
      } catch (error) {
        // WAL/log rotation may remove a file between enumeration and read.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return found
}

test('history, draft and new attachment bytes stay on computer across its restart', async ({
  chat,
  electronApp,
  mainWindow
}) => {
  test.setTimeout(90_000)
  await resetApp(mainWindow)
  const marker = `CHAT-COMPUTER-ONLY-${randomUUID()}`,
    history = `${marker}-history`,
    draft = `${marker}-draft`,
    file = `${marker}-file`
  const t = await chat.openTask({
    title: 'Computer storage privacy',
    spawn: 'on-send',
    scenario: { processes: [] },
    seedEvents: [{ kind: 'assistant-text', messageId: 'saved', text: history }]
  })
  await expect(t.panel.getByText(history, { exact: true })).toBeVisible()
  await t.panel
    .getByTestId('chat-attach-input')
    .setInputFiles([
      { name: 'private-note.txt', mimeType: 'text/plain', buffer: Buffer.from(file) }
    ])
  await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)
  await t.composer.fill(draft)
  await expect
    .poll(() =>
      t.page
        .evaluate(
          (tabId) => window.getTrpcVanillaClient().chat.tabState.get.query({ tabId }),
          t.tabId
        )
        .then((state) => state?.draft.text)
    )
    .toBe(draft)
  const root = await cliRoot(electronApp),
    hub = supervisedHubRoot(root),
    computer = path.join(root, 'dev', 'computer')
  expect(root).toContain('.e2e-runtime')
  for (const content of [history, draft, file]) {
    expect(
      matchingFiles(hub, content),
      'Hub DB/WAL, backups and logs contain no chat marker'
    ).toEqual([])
    expect(
      matchingFiles(computer, content).length,
      'Computer durably owns the content'
    ).toBeGreaterThan(0)
  }

  const restarted = await t.page.evaluate(() => window.__testInvoke('app:restart-local-computer'))
  expect(restarted).toMatchObject({ ok: true })
  await expect
    .poll(
      () =>
        t.page
          .evaluate(
            (tabId) => window.getTrpcVanillaClient().chat.availability.query({ tabId }),
            t.tabId
          )
          .then((value) => value.state),
      { timeout: 30_000 }
    )
    .toBe('ready')
  await t.reload()
  await expect(t.composer).toHaveValue(draft)
  await expect(t.panel.getByTestId('chat-attachment-chip')).toHaveCount(1)
  await expect(t.panel.getByText(history, { exact: true })).toBeVisible()
  for (const content of [history, draft, file]) expect(matchingFiles(hub, content)).toEqual([])
  expect(chat.fake.current().runs()).toHaveLength(0)
})
