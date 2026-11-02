import type { SlayzoneDb } from '@slayzone/platform'

/** Reclaim old free pages once at rollout and after each verified source cleanup. */
export function createChatCompaction(db: SlayzoneDb) {
  let pending: Promise<void> | null = null
  async function checkpoint() {
    const result = await db.get<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)')
    if (result?.busy) throw new Error('Chat privacy checkpoint is busy')
  }
  return {
    run(): Promise<void> {
      if (pending) return pending
      pending = (async () => {
        await db.run(
          "INSERT INTO settings(key,value) VALUES('computer_chat_compaction_generation','1') ON CONFLICT(key) DO NOTHING"
        )
        const generation = (await db.get<{ value: string }>(
          "SELECT value FROM settings WHERE key='computer_chat_compaction_generation'"
        ))!.value
        const done = await db.get<{ value: string }>(
          "SELECT value FROM settings WHERE key='computer_chat_compacted_generation'"
        )
        if (done?.value === generation) return
        await db.exec('PRAGMA secure_delete=ON')
        await checkpoint()
        await db.exec('VACUUM')
        await checkpoint()
        await db.run(
          "INSERT INTO settings(key,value) VALUES('computer_chat_compacted_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [generation]
        )
        await checkpoint()
      })().finally(() => {
        pending = null
      })
      return pending
    }
  }
}
