/** One self-contained bundle: storage workers never initialize CLI/host/enrollment code. */
import { isMainThread, workerData } from 'node:worker_threads'

if (isMainThread) {
  void import('./cli-main')
} else if (workerData?.kind === 'slayzone-chat-storage-owner-v1') {
  void import('@slayzone/chat-runtime/storage-owner-worker').then(({ serveChatStorageOwner }) =>
    serveChatStorageOwner()
  )
} else {
  throw new Error('Unknown computer worker kind')
}
