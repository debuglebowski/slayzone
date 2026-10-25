/**
 * The startup deadline: no output at all within `timeoutMs` ⇒ hung. Pure Node →
 * runs under plain `npx tsx`.
 *
 * The case that matters is the stall. After a blocked event loop, Node runs due
 * TIMERS before it polls I/O — so a deadline that decides inside its own timer
 * judges a session silent while its output is already sitting, unread, in a
 * kernel buffer. That is how a hub stall on 2026-10-23 killed 13 healthy agents.
 *
 * Run with: npx tsx packages/shared/platform/src/startup-deadline.test.ts
 */
import { createServer, connect, type Socket } from 'node:net'
import { armStartupDeadline } from './startup-deadline'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const blockFor = (ms: number): void => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Busy-wait: the event loop is stuck, exactly like a stalled hub.
  }
}

async function main(): Promise<void> {
  // --- silence past the deadline is a verdict ---
  {
    let expired = 0
    armStartupDeadline({ timeoutMs: 20, onExpire: () => expired++ })
    await sleep(80)
    check('expires once when nothing is ever output', expired === 1, `expired=${expired}`)
  }

  // --- output clears it for good ---
  {
    let expired = 0
    const deadline = armStartupDeadline({ timeoutMs: 20, onExpire: () => expired++ })
    deadline.markOutput()
    await sleep(80)
    check('first output clears the deadline', expired === 0, `expired=${expired}`)
  }

  // --- cancel drops it without a verdict ---
  {
    let expired = 0
    const deadline = armStartupDeadline({ timeoutMs: 20, onExpire: () => expired++ })
    deadline.cancel()
    await sleep(80)
    check('cancel never reaches a verdict', expired === 0, `expired=${expired}`)
  }

  // --- output that arrives after the verdict changes nothing ---
  {
    let expired = 0
    const deadline = armStartupDeadline({ timeoutMs: 20, onExpire: () => expired++ })
    await sleep(80)
    deadline.markOutput()
    deadline.cancel()
    check('a late markOutput/cancel after expiry is a harmless no-op', expired === 1)
  }

  // --- the stall: output already waiting in a socket when the timer fires late ---
  {
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const serverSide = new Promise<Socket>((r) => server.once('connection', r))
    const client = connect(port, '127.0.0.1')
    await new Promise<void>((r) => client.once('connect', () => r()))
    const peer = await serverSide

    let expired = 0
    let sawOutputBeforeVerdict = false
    const deadline = armStartupDeadline({
      timeoutMs: 50,
      onExpire: () => {
        expired++
      }
    })
    client.on('data', () => {
      if (expired === 0) sawOutputBeforeVerdict = true
      deadline.markOutput()
    })
    // The session prints right away; the bytes reach the client's kernel buffer...
    peer.write('agent banner')
    // ...but the loop is blocked well past the deadline, so nothing reads them yet.
    blockFor(150)
    await sleep(60)

    check(
      'a deadline that fires late after a stall reads waiting output before judging',
      expired === 0 && sawOutputBeforeVerdict,
      `expired=${expired} sawOutputBeforeVerdict=${sawOutputBeforeVerdict}`
    )
    client.destroy()
    peer.destroy()
    await new Promise<void>((r) => server.close(() => r()))
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
