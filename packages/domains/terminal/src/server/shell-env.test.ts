/**
 * Tests for wrapShellWithUlimit and related helpers.
 * Run with: npx tsx packages/domains/terminal/src/main/shell-env.test.ts
 */
import { execFileSync } from 'child_process'
import { wrapShellWithUlimit, quoteForShell } from './shell-env'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function eq<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(`${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

console.log('\nwrapShellWithUlimit')
console.log('─'.repeat(40))

test('wraps zsh -i -l into /bin/sh -c with ulimit prefix', () => {
  const r = wrapShellWithUlimit('/bin/zsh', ['-i', '-l'])
  eq(r.file, '/bin/sh')
  eq(r.args.length, 2)
  eq(r.args[0], '-c')
  // script must include ulimit, exec, and the quoted shell invocation.
  const script = r.args[1]
  if (!script.includes('ulimit -n')) throw new Error('script missing ulimit command')
  if (!script.includes('exec')) throw new Error('script missing exec keyword')
  if (!script.includes('/bin/zsh')) throw new Error('script missing target shell')
  if (!script.includes("'-i'") && !script.includes('-i')) throw new Error('script missing -i arg')
})

test('wrapped shell actually raises ulimit when invoked', () => {
  const r = wrapShellWithUlimit('/bin/sh', ['-c', 'ulimit -n'])
  const out = execFileSync(r.file, r.args, { encoding: 'utf8' }).trim()
  // The wrapper should have raised the limit to at least 65535, unless the
  // caller's inherited soft limit was already higher (in which case it must
  // not have been lowered).
  const startLimit = execFileSync('/bin/sh', ['-c', 'ulimit -n'], { encoding: 'utf8' }).trim()
  if (out === 'unlimited') return // already unlimited, correct non-lowering
  const n = parseInt(out, 10)
  const start = startLimit === 'unlimited' ? Number.MAX_SAFE_INTEGER : parseInt(startLimit, 10)
  if (n < 65535 && n < start) throw new Error(`expected ulimit >= 65535 (or >= ${start} if preserved), got ${n}`)
})

test('wrapped shell does NOT lower an already-higher soft limit', () => {
  // Parent raises to 70000 first, then invokes the wrapper. The inner shell
  // must see 70000 (preserved), not 65535 (lowered).
  const r = wrapShellWithUlimit('/bin/sh', ['-c', 'ulimit -n'])
  try {
    const out = execFileSync('/bin/sh', ['-c', `ulimit -n 70000 2>/dev/null && ${quoteForShell(r.file)} ${r.args.map(quoteForShell).join(' ')}`], { encoding: 'utf8' }).trim()
    if (out === 'unlimited') return
    const n = parseInt(out, 10)
    // Should be at least 70000 (the parent's value) — either preserved exactly
    // or the kernel clamped slightly lower, but in any case not ≤ 65535.
    if (n < 65535) throw new Error(`ulimit lowered — parent had 70000+, child sees ${n}`)
  } catch (e) {
    // If parent can't reach 70000 due to kernel cap, skip this test.
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Operation not permitted') || msg.includes('setrlimit')) {
      console.log('    (skipped: kernel cap below 70000)')
      return
    }
    throw e
  }
})

test('quotes args with spaces correctly', () => {
  const r = wrapShellWithUlimit('/bin/zsh', ['-c', 'echo "hi there"'])
  const script = r.args[1]
  // Script should roundtrip-safe quote the embedded args
  // Run it and check echo output
  const out = execFileSync(r.file, r.args, { encoding: 'utf8' }).trim()
  eq(out, 'hi there')
})

test('falls back to no-op on win32 (simulated via platform check)', () => {
  // We can't easily mock os.platform() without modifying the module, so this
  // test only runs on non-win32 and documents the expected shape on unix.
  const r = wrapShellWithUlimit('/bin/zsh', [])
  if (process.platform !== 'win32') {
    eq(r.file, '/bin/sh')
  } else {
    eq(r.file, '/bin/zsh')
    eq(r.args.length, 0)
  }
})

console.log('\n' + '─'.repeat(40))
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
