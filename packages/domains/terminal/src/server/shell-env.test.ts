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
    throw new Error(
      `${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
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
  if (n < 65535 && n < start)
    throw new Error(`expected ulimit >= 65535 (or >= ${start} if preserved), got ${n}`)
})

test('wrapped shell does NOT lower an already-higher soft limit', () => {
  // Parent raises its soft limit above the wrapper's 65535 floor, then invokes the
  // wrapper. The inner shell must see the parent's value (preserved), not 65535.
  // The parent can only go above 65535 if the hard limit allows it: GitHub's Linux
  // runners cap it at 65536, macOS is unlimited, docker defaults to 1048576.
  const hard = execFileSync('/bin/sh', ['-c', 'ulimit -Hn'], { encoding: 'utf8' }).trim()
  const parent = hard === 'unlimited' ? 70000 : Math.min(parseInt(hard, 10), 70000)
  if (parent <= 65535) {
    console.log(`    (skipped: hard limit ${hard} leaves no room above 65535)`)
    return
  }
  const r = wrapShellWithUlimit('/bin/sh', ['-c', 'ulimit -n'])
  const out = execFileSync(
    '/bin/sh',
    [
      '-c',
      `ulimit -n ${parent} && ${quoteForShell(r.file)} ${r.args.map(quoteForShell).join(' ')}`
    ],
    { encoding: 'utf8' }
  ).trim()
  if (out === 'unlimited') return
  const n = parseInt(out, 10)
  if (n < parent) throw new Error(`ulimit lowered — parent had ${parent}, child sees ${n}`)
})

test('quotes args with spaces correctly', () => {
  // /bin/sh, not zsh: the case is the quoting through the wrapper, and only sh is on
  // every machine that runs this (Linux CI images ship without zsh).
  const r = wrapShellWithUlimit('/bin/sh', ['-c', 'echo "hi there"'])
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
