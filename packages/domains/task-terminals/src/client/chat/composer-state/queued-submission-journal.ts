import {
  parseQueuedSubmission,
  type QueuedSubmission,
  type QueuedSubmissionStorage
} from '../queued-submissions'

export function createQueuedSubmissionJournal(
  hubId: string,
  tabId: string
): QueuedSubmissionStorage {
  const prefix = `slayzone:chat-queue:${JSON.stringify([hubId, tabId])}:`
  return {
    async list() {
      const entries: QueuedSubmission[] = []
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (!key?.startsWith(prefix)) continue
        const entry = parseQueuedSubmission(localStorage.getItem(key) ?? '')
        if (entry && key === prefix + entry.id) entries.push(entry)
      }
      return entries
    },
    async put(entry) {
      localStorage.setItem(prefix + entry.id, JSON.stringify(entry))
    },
    async remove(id) {
      localStorage.removeItem(prefix + id)
    }
  }
}
