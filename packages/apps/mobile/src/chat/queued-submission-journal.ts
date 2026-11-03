import { Directory, File, Paths } from 'expo-file-system'
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto'
import {
  parseQueuedSubmission,
  queuedSubmissionInputKey,
  type QueuedSubmission,
  type QueuedSubmissionStorage
} from '@slayzone/task-terminals/queued-submissions'

const writing = new Set<string>()
/** App-private content journal. Immutable entries avoid delete-before-replace native moves. */
export function createQueuedSubmissionJournal(
  hubId: string,
  tabId: string
): QueuedSubmissionStorage {
  const directory = digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    JSON.stringify([hubId, tabId])
  ).then((scope) => {
    const dir = new Directory(Paths.document, 'chat-queue', scope)
    dir.create({ intermediates: true, idempotent: true })
    return dir
  })
  void directory.catch(() => {
    /* Submit reports failure before any RPC. */
  })
  return {
    async list() {
      const dir = await directory
      const entries: QueuedSubmission[] = []
      const seen = new Set<string>()
      for (const file of dir.list().sort((a, b) => a.name.localeCompare(b.name))) {
        if (
          !(file instanceof File) ||
          (!file.name.endsWith('.json') && !file.name.endsWith('.tmp')) ||
          writing.has(file.uri)
        )
          continue
        const entry = parseQueuedSubmission(await file.text())
        if (entry && (file.name === `${entry.id}.json` || file.name.startsWith(`${entry.id}.`))) {
          if (!seen.has(entry.id)) {
            entries.push(entry)
            seen.add(entry.id)
          }
        } else if (file.name.endsWith('.tmp')) file.delete()
      }
      return entries
    },
    async put(entry) {
      const dir = await directory
      const destination = new File(dir, `${entry.id}.json`)
      const matches = async () => {
        if (!destination.exists) return false
        const previous = parseQueuedSubmission(await destination.text())
        if (
          !previous ||
          previous.id !== entry.id ||
          queuedSubmissionInputKey(previous) !== queuedSubmissionInputKey(entry)
        )
          throw new Error('Queued submission journal identity conflict')
        return true
      }
      if (await matches()) return
      const staging = new File(dir, `${entry.id}.${randomUUID()}.tmp`)
      const stagingUri = staging.uri
      writing.add(stagingUri)
      try {
        await staging.write(JSON.stringify(entry))
        try {
          await staging.move(destination)
        } catch (err) {
          // A second editor may have committed this immutable identity first.
          if (!(await matches())) throw err
        }
      } finally {
        writing.delete(stagingUri)
        const remainder = new File(stagingUri)
        if (remainder.exists) remainder.delete()
      }
    },
    async remove(id) {
      for (const file of (await directory).list())
        if (
          file instanceof File &&
          (file.name === `${id}.json` || file.name.startsWith(`${id}.`)) &&
          !writing.has(file.uri)
        )
          file.delete()
    }
  }
}
