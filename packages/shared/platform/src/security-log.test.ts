/**
 * The security audit emitter (T-03): line shape, redaction at any depth, clipping,
 * the acting-user context, and that it never throws — not on a circular detail, a
 * throwing sink, a throwing stdout, nor an EPIPE emitted on stdout afterwards.
 * Pure Node → runs under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/security-log.test.ts
 */
import { describe, expect, test } from 'vitest'
import {
  SECURITY_EVENTS,
  peerAddress,
  routeOf,
  runAsSecurityActor,
  runWithSecurityContext,
  securityEvent,
  setSecurityLogSink
} from './security-log'

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
  expect(lines.length, `exactly one line, got ${lines.length}`).toBe(1)
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

describe('security-log: line shape', () => {
  test('one JSON line with every field, type first, nulls for the unknown', () => {
    const lines = capture(() => securityEvent({ event: 'auth.signin', outcome: 'success' }))
    expect(lines[0]!, 'no newline inside the line').not.toContain('\n')
    expect(lines[0]!.startsWith('{"type":"security",'), `starts with the type: ${lines[0]}`).toBe(
      true
    )
    const e = only(lines)
    expect(Object.keys(e), 'field order').toEqual([
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
    ])
    expect(e.event, 'event + outcome').toBe('auth.signin')
    expect(e.outcome, 'event + outcome').toBe('success')
    expect(Number.isNaN(Date.parse(e.ts as string)), 'ISO ts').toBe(false)
    expect((e.ts as string).endsWith('Z'), 'ISO ts').toBe(true)
    for (const k of ['actor', 'ip', 'targetKind', 'targetId', 'route']) {
      expect(e[k], `${k} is null`).toBeNull()
    }
    expect(JSON.stringify(e.detail), 'empty detail is {}').toBe('{}')
  })

  test('level: info for success, warn for failure and denied, explicit wins', () => {
    const levels = capture(() => {
      securityEvent({ event: 'auth.signin', outcome: 'success' })
      securityEvent({ event: 'auth.signin', outcome: 'failure' })
      securityEvent({ event: 'authz.denied', outcome: 'denied' })
      securityEvent({ event: 'hub.boot', outcome: 'denied', level: 'error' })
    }).map((l) => (JSON.parse(l) as { level: string }).level)
    expect(levels.join(), `levels: ${levels.join()}`).toBe('info,warn,warn,error')
  })

  test('fields carried through; route loses its query string', () => {
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
    expect(e.actor, 'actor + ip').toBe('u1')
    expect(e.ip, 'actor + ip').toBe('10.0.0.1')
    expect(e.targetKind, 'target').toBe('computer')
    expect(e.targetId, 'target').toBe('c1')
    expect(e.route, `route: ${e.route}`).toBe('GET /api/x')
    expect(JSON.stringify(e.detail), `detail: ${JSON.stringify(e.detail)}`).toBe(
      '{"reason":"R","count":2,"ok":true,"none":null}'
    )
  })
})

describe('security-log: redaction', () => {
  test('password, token, prompt and friends never appear, at any depth, any case', () => {
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
      expect(line, `'${leak}' leaked: ${line}`).not.toContain(leak)
    }
    for (const kept of ['kept-0', 'kept-1', 'kept-2']) {
      expect(line, `non-sensitive '${kept}' kept: ${line}`).toContain(kept)
    }
  })

  test('bytes are never logged, whatever their key', () => {
    const line = capture(() =>
      securityEvent({
        event: 'computer.fs.write',
        outcome: 'success',
        detail: { chunk: Buffer.from('raw-terminal-bytes'), view: new Uint8Array([1, 2, 3]) }
      })
    )[0]!
    expect(line, 'buffer content absent').not.toContain('raw-terminal-bytes')
    expect(line, line).toContain('"chunk":"[bytes]"')
    expect(line, line).toContain('"view":"[bytes]"')
  })
})

describe('security-log: clipping', () => {
  test('long strings clipped to 200 chars, everywhere', () => {
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
    expect((e.actor as string).length, `actor clipped: ${(e.actor as string).length}`).toBe(201)
    expect((e.route as string).length, 'route clipped').toBe(201)
    const d = e.detail as { origin: string; nested: { v: string } }
    expect(d.origin.length, 'detail string clipped').toBe(201)
    expect(d.origin.endsWith('…'), 'detail string clipped').toBe(true)
    expect(d.nested.v.length, 'nested string clipped').toBe(201)
  })

  test('arrays, key count and depth are bounded', () => {
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
    expect(d.roots.length, `roots: ${d.roots.length}`).toBe(21)
    expect(d.roots[20], `roots: ${d.roots.length}`).toBe('…30 more')
    expect(Object.keys(d.wide).length, `keys: ${Object.keys(d.wide).length}`).toBe(30)
    expect(d.a.b.c.d, `depth: ${JSON.stringify(d.a)}`).toBe('[depth]')
  })

  const LS = String.fromCharCode(0x2028)
  test('a newline in a value cannot forge a second line; U+2028 is escaped', () => {
    const lines = capture(() =>
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        detail: { origin: `a\n{"type":"security","event":"forged"}${LS}b` }
      })
    )
    expect(lines.length, 'still one line').toBe(1)
    expect(lines[0]!, 'still one line').not.toContain('\n')
    expect(lines[0]!, 'U+2028 escaped').not.toContain(LS)
    expect(lines[0]!, 'U+2028 escaped').toContain('\\u2028')
  })
})

describe('security-log: never throws', () => {
  test('a circular detail is cut, not thrown', () => {
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    const e = only(
      capture(() => securityEvent({ event: 'hub.boot', outcome: 'denied', detail: loop }))
    )
    expect((e.detail as { self: unknown }).self, JSON.stringify(e.detail)).toBe('[circular]')
  })

  test('a throwing getter, a class instance and odd values do not throw', () => {
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
    expect(d.err, `error reduced to its class: ${String(d.err)}`).toBe('[Error]')
    expect(JSON.stringify(d), 'error message absent').not.toContain('secret in a message')
    expect(d.big, 'coerced').toBe('10')
    expect(d.nan, 'coerced').toBe('NaN')
    expect(d.when, 'coerced').toBe('1970-01-01T00:00:00.000Z')
    expect(d, 'functions and symbols dropped').not.toHaveProperty('fn')
    expect(d, 'functions and symbols dropped').not.toHaveProperty('sym')
  })

  test('a throwing sink does not reach the caller', () => {
    setSecurityLogSink(() => {
      throw new Error('sink down')
    })
    try {
      securityEvent({ event: 'auth.signin', outcome: 'success' })
    } finally {
      setSecurityLogSink()
    }
  })

  test('a throwing stdout write, then an EPIPE error event on stdout, do not throw', () => {
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
    expect(
      process.stdout.listenerCount('error'),
      'stdout error listener installed'
    ).toBeGreaterThan(0)
    process.stdout.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))
  })
})

describe('security-log: acting-user context', () => {
  test('context fills actor/ip/route across awaits; explicit values and null win', async () => {
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
    expect(inside!.actor, 'filled from context').toBe('u-ctx')
    expect(inside!.ip, 'filled from context').toBe('10.1.1.1')
    expect(inside!.route, 'route from context').toBe('trpc pty.create')
    expect(overridden!.actor, 'explicit null/value win').toBeNull()
    expect(overridden!.ip, 'explicit null/value win').toBe('10.2.2.2')
    expect(outside!.actor, 'no context outside the run').toBeNull()
    expect(outside!.route, 'no context outside the run').toBeNull()
  })

  test('runAsSecurityActor swaps only the actor', async () => {
    const seen = await runWithSecurityContext(
      { actor: null, ip: '10.3.3.3', route: 'POST /api/hub/users' },
      () =>
        runAsSecurityActor('u-verified', async () => {
          await new Promise((r) => setTimeout(r, 1))
          return capture(() => securityEvent({ event: 'user.create', outcome: 'success' }))
        })
    )
    const e = only(seen)
    expect(e.actor, `actor swapped, ip kept: ${seen[0]}`).toBe('u-verified')
    expect(e.ip, `actor swapped, ip kept: ${seen[0]}`).toBe('10.3.3.3')
    expect(e.route, 'route kept').toBe('POST /api/hub/users')
  })

  test('peerAddress and routeOf', () => {
    expect(peerAddress({ socket: { remoteAddress: '::1' } }), 'peer').toBe('::1')
    expect(peerAddress(undefined), 'absent').toBeNull()
    expect(peerAddress({ socket: null }), 'absent').toBeNull()
    expect(routeOf('POST', '/api/x?token=abc'), 'route without query').toBe('POST /api/x')
  })

  test('event names are unique and include the names reserved for T-04..T-07, T-23', () => {
    expect(new Set(SECURITY_EVENTS).size, 'unique').toBe(SECURITY_EVENTS.length)
    for (const name of [
      'hub.process.spawn',
      'automation.run_command',
      'hub.local_exec',
      'integration.connect',
      'hub.retention.sweep'
    ]) {
      expect(SECURITY_EVENTS as readonly string[], `${name} reserved`).toContain(name)
    }
  })
})
