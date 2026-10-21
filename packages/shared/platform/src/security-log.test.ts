/**
 * The security audit emitter (T-03): line shape, redaction at any depth, clipping,
 * the acting-user context, and that it never throws — not on a circular detail, a
 * throwing sink, a throwing stdout, nor an EPIPE emitted on stdout afterwards.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/security-log.test.ts
 */
import {
  SECURITY_EVENTS,
  peerAddress,
  routeOf,
  runAsSecurityActor,
  runWithSecurityContext,
  securityEvent,
  setSecurityLogSink
} from './security-log'

let passed = 0
let failed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`)
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

/** Run `fn` and return every line the emitter produced. */
function capture(fn: () => void): string[] {
  const lines: string[] = []
  setSecurityLogSink((line) => lines.push(line))
  try {
    fn()
  } finally {
    setSecurityLogSink()
  }
  return lines
}
const only = (lines: string[]): Record<string, unknown> => {
  assert(lines.length === 1, `exactly one line, got ${lines.length}`)
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

console.log('\nsecurity-log: line shape')
console.log('─'.repeat(40))

await test('one JSON line with every field, type first, nulls for the unknown', () => {
  const lines = capture(() => securityEvent({ event: 'auth.signin', outcome: 'success' }))
  assert(!lines[0]!.includes('\n'), 'no newline inside the line')
  assert(lines[0]!.startsWith('{"type":"security",'), `starts with the type: ${lines[0]}`)
  const e = only(lines)
  assert(
    JSON.stringify(Object.keys(e)) ===
      JSON.stringify([
        'type',
        'ts',
        'level',
        'event',
        'outcome',
        'actor',
        'ip',
        'targetKind',
        'targetId',
        'route',
        'detail'
      ]),
    `field order: ${Object.keys(e).join(',')}`
  )
  assert(e.event === 'auth.signin' && e.outcome === 'success', 'event + outcome')
  assert(!Number.isNaN(Date.parse(e.ts as string)) && (e.ts as string).endsWith('Z'), 'ISO ts')
  for (const k of ['actor', 'ip', 'targetKind', 'targetId', 'route']) {
    assert(e[k] === null, `${k} is null`)
  }
  assert(JSON.stringify(e.detail) === '{}', 'empty detail is {}')
})

await test('level: info for success, warn for failure and denied, explicit wins', () => {
  const levels = capture(() => {
    securityEvent({ event: 'auth.signin', outcome: 'success' })
    securityEvent({ event: 'auth.signin', outcome: 'failure' })
    securityEvent({ event: 'authz.denied', outcome: 'denied' })
    securityEvent({ event: 'hub.boot', outcome: 'denied', level: 'error' })
  }).map((l) => (JSON.parse(l) as { level: string }).level)
  assert(levels.join() === 'info,warn,warn,error', `levels: ${levels.join()}`)
})

await test('fields carried through; route loses its query string', () => {
  const e = only(
    capture(() =>
      securityEvent({
        event: 'computer.revoke',
        outcome: 'success',
        actor: 'u1',
        ip: '10.0.0.1',
        targetKind: 'computer',
        targetId: 'c1',
        route: 'GET /api/x?code=secret',
        detail: { reason: 'R', count: 2, ok: true, none: null }
      })
    )
  )
  assert(e.actor === 'u1' && e.ip === '10.0.0.1', 'actor + ip')
  assert(e.targetKind === 'computer' && e.targetId === 'c1', 'target')
  assert(e.route === 'GET /api/x', `route: ${e.route}`)
  assert(
    JSON.stringify(e.detail) === '{"reason":"R","count":2,"ok":true,"none":null}',
    `detail: ${JSON.stringify(e.detail)}`
  )
})

console.log('\nsecurity-log: redaction')
console.log('─'.repeat(40))

await test('password, token, prompt and friends never appear, at any depth, any case', () => {
  const lines = capture(() =>
    securityEvent({
      event: 'computer.pty.spawn',
      outcome: 'success',
      detail: {
        password: 'P1-hunter2',
        Password: 'P2-hunter2',
        newPassword: 'P3-hunter2',
        token: 'T1-tok',
        sessionToken: 'T2-tok',
        apiKey: 'K1-key',
        API_KEY: 'K2-key',
        secret: 'S1-sec',
        clientSecret: 'S2-sec',
        Authorization: 'Bearer A1',
        cookie: 'C1=x',
        prompt: 'PR1 do the thing',
        initialPrompt: 'PR2 do the thing',
        content: 'F1 file body',
        data: 'B1 terminal bytes',
        args: ['--prompt', 'PR3'],
        email: 'someone@example.com',
        nested: {
          deeper: { password: 'P4-hunter2', token: 'T3-tok', keep: 'kept-1' },
          list: [{ prompt: 'PR4', keep: 'kept-2' }]
        },
        keep: 'kept-0'
      }
    })
  )
  const line = lines[0]!
  for (const leak of [
    'P1-',
    'P2-',
    'P3-',
    'P4-',
    'T1-',
    'T2-',
    'T3-',
    'K1-',
    'K2-',
    'S1-',
    'S2-',
    'A1',
    'C1=',
    'PR1',
    'PR2',
    'PR3',
    'PR4',
    'F1 ',
    'B1 ',
    'example.com'
  ]) {
    assert(!line.includes(leak), `'${leak}' leaked: ${line}`)
  }
  for (const kept of ['kept-0', 'kept-1', 'kept-2']) {
    assert(line.includes(kept), `non-sensitive '${kept}' kept: ${line}`)
  }
})

await test('bytes are never logged, whatever their key', () => {
  const line = capture(() =>
    securityEvent({
      event: 'computer.fs.write',
      outcome: 'success',
      detail: { chunk: Buffer.from('raw-terminal-bytes'), view: new Uint8Array([1, 2, 3]) }
    })
  )[0]!
  assert(!line.includes('raw-terminal-bytes'), 'buffer content absent')
  assert(line.includes('"chunk":"[bytes]"') && line.includes('"view":"[bytes]"'), line)
})

console.log('\nsecurity-log: clipping')
console.log('─'.repeat(40))

await test('long strings clipped to 200 chars, everywhere', () => {
  const long = 'x'.repeat(5000)
  const e = only(
    capture(() =>
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        actor: long,
        route: `GET /${long}`,
        detail: { origin: long, nested: { v: long } }
      })
    )
  )
  assert((e.actor as string).length === 201, `actor clipped: ${(e.actor as string).length}`)
  assert((e.route as string).length === 201, 'route clipped')
  const d = e.detail as { origin: string; nested: { v: string } }
  assert(d.origin.length === 201 && d.origin.endsWith('…'), 'detail string clipped')
  assert(d.nested.v.length === 201, 'nested string clipped')
})

await test('arrays, key count and depth are bounded', () => {
  const wide: Record<string, number> = {}
  for (let i = 0; i < 100; i++) wide[`k${i}`] = i
  const e = only(
    capture(() =>
      securityEvent({
        event: 'computer.allowed_roots.set',
        outcome: 'success',
        detail: {
          roots: Array.from({ length: 50 }, (_, i) => `/r${i}`),
          wide,
          a: { b: { c: { d: { e: 'too deep' } } } }
        }
      })
    )
  )
  const d = e.detail as { roots: string[]; wide: object; a: { b: { c: { d: unknown } } } }
  assert(d.roots.length === 21 && d.roots[20] === '…30 more', `roots: ${d.roots.length}`)
  assert(Object.keys(d.wide).length === 30, `keys: ${Object.keys(d.wide).length}`)
  assert(d.a.b.c.d === '[depth]', `depth: ${JSON.stringify(d.a)}`)
})

const LS = String.fromCharCode(0x2028)
await test('a newline in a value cannot forge a second line; U+2028 is escaped', () => {
  const lines = capture(() =>
    securityEvent({
      event: 'authz.denied',
      outcome: 'denied',
      detail: { origin: `a\n{"type":"security","event":"forged"}${LS}b` }
    })
  )
  assert(lines.length === 1 && !lines[0]!.includes('\n'), 'still one line')
  assert(!lines[0]!.includes(LS) && lines[0]!.includes('\\u2028'), 'U+2028 escaped')
})

console.log('\nsecurity-log: never throws')
console.log('─'.repeat(40))

await test('a circular detail is cut, not thrown', () => {
  const loop: Record<string, unknown> = { name: 'loop' }
  loop.self = loop
  const e = only(
    capture(() => securityEvent({ event: 'hub.boot', outcome: 'denied', detail: loop }))
  )
  assert((e.detail as { self: unknown }).self === '[circular]', JSON.stringify(e.detail))
})

await test('a throwing getter, a class instance and odd values do not throw', () => {
  const hostile = {
    get boom(): string {
      throw new Error('getter')
    }
  }
  capture(() => securityEvent({ event: 'hub.boot', outcome: 'denied', detail: hostile }))
  const e = only(
    capture(() =>
      securityEvent({
        event: 'hub.boot',
        outcome: 'denied',
        detail: {
          err: new Error('secret in a message'),
          big: 10n,
          nan: Number.NaN,
          fn: () => 1,
          sym: Symbol('s'),
          when: new Date(0)
        }
      })
    )
  )
  const d = e.detail as Record<string, unknown>
  assert(d.err === '[Error]', `error reduced to its class: ${String(d.err)}`)
  assert(!JSON.stringify(d).includes('secret in a message'), 'error message absent')
  assert(d.big === '10' && d.nan === 'NaN' && d.when === '1970-01-01T00:00:00.000Z', 'coerced')
  assert(!('fn' in d) && !('sym' in d), 'functions and symbols dropped')
})

await test('a throwing sink does not reach the caller', () => {
  setSecurityLogSink(() => {
    throw new Error('sink down')
  })
  try {
    securityEvent({ event: 'auth.signin', outcome: 'success' })
  } finally {
    setSecurityLogSink()
  }
})

await test('a throwing stdout write, then an EPIPE error event on stdout, do not throw', () => {
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => {
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  }) as typeof process.stdout.write
  try {
    securityEvent({ event: 'auth.signin', outcome: 'success' })
  } finally {
    process.stdout.write = original
  }
  // The default sink installed its guard on first use: an async stdout error must
  // not become an uncaught exception that takes the hub down.
  assert(process.stdout.listenerCount('error') > 0, 'stdout error listener installed')
  process.stdout.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))
})

console.log('\nsecurity-log: acting-user context')
console.log('─'.repeat(40))

await test('context fills actor/ip/route across awaits; explicit values and null win', async () => {
  const lines: string[] = []
  setSecurityLogSink((line) => lines.push(line))
  try {
    await runWithSecurityContext(
      { actor: 'u-ctx', ip: '10.1.1.1', route: 'trpc pty.create' },
      async () => {
        await new Promise((r) => setTimeout(r, 1))
        securityEvent({ event: 'computer.pty.spawn', outcome: 'success' })
        securityEvent({
          event: 'computer.pty.spawn',
          outcome: 'success',
          actor: null,
          ip: '10.2.2.2'
        })
      }
    )
    securityEvent({ event: 'computer.pty.spawn', outcome: 'success' })
  } finally {
    setSecurityLogSink()
  }
  const [inside, overridden, outside] = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  assert(inside!.actor === 'u-ctx' && inside!.ip === '10.1.1.1', 'filled from context')
  assert(inside!.route === 'trpc pty.create', 'route from context')
  assert(overridden!.actor === null && overridden!.ip === '10.2.2.2', 'explicit null/value win')
  assert(outside!.actor === null && outside!.route === null, 'no context outside the run')
})

await test('runAsSecurityActor swaps only the actor', async () => {
  const seen = await runWithSecurityContext(
    { actor: null, ip: '10.3.3.3', route: 'POST /api/hub/users' },
    () =>
      runAsSecurityActor('u-verified', async () => {
        await new Promise((r) => setTimeout(r, 1))
        return capture(() => securityEvent({ event: 'user.create', outcome: 'success' }))
      })
  )
  const e = only(seen)
  assert(e.actor === 'u-verified' && e.ip === '10.3.3.3', `actor swapped, ip kept: ${seen[0]}`)
  assert(e.route === 'POST /api/hub/users', 'route kept')
})

await test('peerAddress and routeOf', () => {
  assert(peerAddress({ socket: { remoteAddress: '::1' } }) === '::1', 'peer')
  assert(peerAddress(undefined) === null && peerAddress({ socket: null }) === null, 'absent')
  assert(routeOf('POST', '/api/x?token=abc') === 'POST /api/x', 'route without query')
})

await test('event names are unique and include the names reserved for T-04..T-07, T-23', () => {
  assert(new Set(SECURITY_EVENTS).size === SECURITY_EVENTS.length, 'unique')
  for (const name of [
    'hub.process.spawn',
    'automation.run_command',
    'hub.local_exec',
    'integration.connect',
    'hub.retention.sweep'
  ]) {
    assert((SECURITY_EVENTS as readonly string[]).includes(name), `${name} reserved`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
