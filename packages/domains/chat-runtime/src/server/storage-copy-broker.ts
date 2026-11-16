/** Main owns every physical copy thread, including after its writer dies. */
import { startCompactionWorker, type WorkerHandle } from './compaction-worker-host'
import type { CopyControl, HostControl } from './storage-owner-protocol'

export function createStorageCopyBroker(post: (message: HostControl) => void) {
  const copies = new Map<string, WorkerHandle>()
  let closing = false
  return {
    async request(request: CopyControl): Promise<unknown> {
      if (request.operation === 'copy-start') {
        if (closing) throw new Error('Storage copy broker is closed')
        if (copies.has(request.token)) throw new Error('Storage copy already exists')
        const { token, spec } = request
        const copy = startCompactionWorker({
          ...spec,
          exit: () => {
            copies.delete(token)
            post({ type: 'copy-exit', token })
          },
          progress: (bytes) => post({ type: 'copy-progress', token, bytes })
        })
        copies.set(token, copy)
        return copy.ready
      }
      const copy = copies.get(request.token)
      if (request.operation === 'copy-terminate') {
        // An earlier physical exit removes the handle; never wait on owner.close.
        await copy?.terminate()
        return
      }
      if (!copy) throw new Error('Storage copy has exited')
      if (request.operation === 'copy-delta') return copy.copy(request.tables, request.keys)
      return copy.finish(request.check)
    },
    async close() {
      closing = true
      await Promise.all([...copies.values()].map((copy) => copy.terminate()))
    }
  }
}
