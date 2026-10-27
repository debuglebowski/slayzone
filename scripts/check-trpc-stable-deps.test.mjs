/**
 * Tests for scripts/check-trpc-stable-deps.sh (`pnpm lint:trpc-deps`): it must flag a
 * useMutation() result object bare in a hook dep array — by `*Mutation` name and by
 * binding, one-line and multi-line — and stay quiet on the stable forms.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { test, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-trpc-stable-deps.sh')

/** Runs the guard over one fixture file; returns { status, hits: ['<line>:<text>'] }. */
function check(source, name = 'Fixture.tsx') {
  const dir = mkdtempSync(join(tmpdir(), 'trpc-deps-'))
  try {
    writeFileSync(join(dir, name), source)
    const r = spawnSync('bash', [GUARD, dir], { encoding: 'utf8' })
    const prefix = `${join(dir, name)}:`
    const hits = r.stdout
      .split('\n')
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length))
    return { status: r.status, hits, out: r.stdout + r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function flags(source, lines) {
  const r = check(source)
  expect(r.status, r.out).toBe(1)
  const got = r.hits.map((h) => Number(h.split(':')[0]))
  expect(got, r.out).toEqual(lines)
}

function passes(source) {
  const r = check(source)
  expect(r.status, r.out).toBe(0)
}

const TANSTACK = `import { useMutation } from '@tanstack/react-query'\n`

// ── by binding (new) ─────────────────────────────────────────────────────────

// The shape useTaskTerminalSession shipped with: a non-`*Mutation` name, listed last
// in a multi-line dep array — invisible to the by-name pass.
test('flags a useMutation() object bare in a multi-line dep array (useTaskTerminalSession)', () => {
  flags(
    `${TANSTACK}export function useX(task) {
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  useEffect(() => {
    void updateTask.mutateAsync({ id: task.id })
  }, [
    task,
    updateTask
  ])
}
`,
    [8]
  )
})

test('flags it in a one-line dep array too', () => {
  flags(
    `${TANSTACK}function C() {
  const mkdir = useMutation(trpc.workspace.mkdir.mutationOptions())
  const go = useCallback(async () => { await mkdir.mutateAsync({}) }, [cwd, mkdir])
}
`,
    [4]
  )
})

test('passes the fix: destructured mutateAsync in the deps', () => {
  passes(
    `${TANSTACK}export function useX(task) {
  const { mutateAsync: updateTask } = useMutation(trpc.task.update.mutationOptions())
  useEffect(() => {
    void updateTask({ id: task.id })
  }, [
    task,
    updateTask
  ])
}
`
  )
})

test('passes a dereferenced member in the deps (.mutateAsync, ?.reset, !.mutate)', () => {
  passes(
    `${TANSTACK}function C() {
  const save = useMutation(opts)
  useEffect(() => {}, [save.mutateAsync, save?.reset, save!.mutate])
}
`
  )
})

test('passes a binding of the member: useMutation(...).mutate, multi-line', () => {
  passes(
    `${TANSTACK}function C() {
  const setTab = useMutation(
    trpc.app.webview.setActiveBrowserTab.mutationOptions({ onSuccess: (r) => f(r) })
  ).mutate
  useEffect(() => { setTab({}) }, [setTab])
}
`
  )
})

test('passes convex/react useMutation (memoized function, not a result object)', () => {
  passes(
    `import { useMutation } from 'convex/react'
function C() {
  const syncDailyStats = useMutation(api.leaderboard.syncDailyStats)
  useEffect(() => { void syncDailyStats({}) }, [syncDailyStats])
}
`
  )
})

test('flags an aliased TanStack useMutation', () => {
  flags(
    `import { useMutation as useRqMutation } from '@tanstack/react-query'
function C() {
  const save = useRqMutation(opts)
  useEffect(() => {}, [save])
}
`,
    [4]
  )
})

test('flags a generic useMutation<T>() binding', () => {
  flags(
    `${TANSTACK}function C() {
  const save = useMutation<Result, Error, Input>({ mutationFn })
  const go = useCallback(() => save.mutate({}), [save])
}
`,
    [4]
  )
})

test('a member of another object with the same name is not the binding', () => {
  passes(
    `${TANSTACK}function C(props) {
  const save = useMutation(opts)
  useEffect(() => {}, [props.save, other?.save])
}
`
  )
})

test('names inside strings and comments do not count', () => {
  passes(
    `${TANSTACK}function C() {
  const save = useMutation(opts)
  const keys = ['save', "save"]
  useEffect(() => {}, [a /* save */, b]) // [save]
}
`
  )
})

// ── by name (existing behaviour, unchanged) ──────────────────────────────────

test('still flags a *Mutation-named token from outside the file (prop)', () => {
  flags(
    `function C({ saveMutation }) {
  useEffect(() => {}, [saveMutation])
}
`,
    [2]
  )
})

test('still lets off a *Mutation name bound to useCallback/useMemo/useRef', () => {
  passes(
    `function C() {
  const runGroupMutation = useCallback(() => {}, [])
  useEffect(() => {}, [runGroupMutation])
}
`
  )
})

test('a line both passes catch is reported once', () => {
  flags(
    `${TANSTACK}function C() {
  const saveMutation = useMutation(opts)
  useEffect(() => {}, [saveMutation])
}
`,
    [4]
  )
})
