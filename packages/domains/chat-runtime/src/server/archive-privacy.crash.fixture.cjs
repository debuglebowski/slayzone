require('tsx/cjs')
const { readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { openComputerChatRuntime } = require('./computer-online-runtime.ts')
const [stateDir, workerPath] = process.argv.slice(2)
;(async () => {
  const r = await openComputerChatRuntime({
    stateDir,
    hubScope: 'hub',
    computerId: 'pc',
    workerPath,
    blobBackfill: { automatic: false },
    markerBackfill: { automatic: false }
  })
  for (const taskId of ['alice', 'bob', 'carol']) {
    await r.storage.createConversation({
      id: taskId,
      taskId,
      tabId: taskId,
      mode: 'claude-chat',
      epoch: 1
    })
    for (let i = 0; i < (taskId === 'bob' ? 192 : 1); i++)
      await r.storage.append(taskId, 1, {
        kind: 'assistant-text',
        messageId: String(i),
        text: `${taskId} crash secret ${'x'.repeat(taskId === 'bob' ? 128 * 1024 : 0)}`
      })
  }
  const backup = await r.backups.create()
  const archive = await r.backups.restore(backup.id)
  const path = join(r.backups.archiveDir, archive.id)
  const timer = setInterval(() => {
    const copy = readdirSync(path).find(
      (name) => name.startsWith('chat.sqlite.compact-') && !/-(wal|shm|journal)$/.test(name)
    )
    if (copy && statSync(join(path, copy)).size >= 16 * 1024 * 1024) {
      // Real canonical deletion + main-broker native copy. Kill the whole process
      // during the copy's fsync/pause, before its completion/rename/manifest.
      process.stdout.write(JSON.stringify({ archive: archive.id, backup: backup.id, copy }) + '\n')
      process.kill(process.pid, 'SIGKILL')
    }
  }, 1)
  await r.backups.eraseTask('alice')
  clearInterval(timer)
  throw new Error('Archive crash point was not reached')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
