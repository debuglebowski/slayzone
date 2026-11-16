import type {
  OnlineComputerChatRuntime,
  ComputerChatTestRequest
} from '@slayzone/chat-runtime/server'
export { chatTestRequestSchema } from '@slayzone/chat-runtime/server'
export async function handleChatTesting(
  r: OnlineComputerChatRuntime,
  req: ComputerChatTestRequest
) {
  if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
  if (req.kind === 'test.watchdog') {
    r.ops.testSetWatchdogTimings(req.timings)
    return { ok: true }
  }
  return r.testing.handle(req)
}
