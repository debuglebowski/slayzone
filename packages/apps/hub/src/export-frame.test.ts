/**
 * The export frame's bootstrap (export-frame.ts), run against a stand-in window: the
 * frame keeps `allow-modals` (print() needs it), so the bootstrap takes the native
 * alert/confirm/prompt away from the document it writes (review 8, L4). The real
 * browser behaviour is e2e 207's "cannot raise alert/confirm/prompt" case.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/export-frame.test.ts
 */
import { expect, test, vi } from 'vitest'
import { EXPORT_FRAME_HTML, EXPORT_FRAME_VERSION } from './export-frame.js'

function bootstrapSource(): string {
  const match = /<script>([\s\S]*)<\/script>/.exec(EXPORT_FRAME_HTML)
  if (!match) throw new Error('no bootstrap script in EXPORT_FRAME_HTML')
  return match[1]
}

/** Run the bootstrap with a window whose dialogs are spies, framed by a parent. */
function boot() {
  const native = {
    alert: vi.fn(),
    confirm: vi.fn(() => true),
    prompt: vi.fn(() => 'secret')
  }
  const posted: unknown[] = []
  const win: Record<string, unknown> = {
    ...native,
    parent: { postMessage: (message: unknown) => posted.push(message) },
    addEventListener: () => {}
  }
  new Function('window', bootstrapSource())(win)
  return { win, native, posted }
}

test('the bootstrap announces itself to its parent', () => {
  expect(boot().posted).toEqual([{ slayzoneExportFrame: EXPORT_FRAME_VERSION }])
})

test('alert/confirm/prompt are no-ops from the start: alert undefined, confirm false, prompt null', () => {
  const { win, native } = boot()
  const call = (name: string, ...args: unknown[]) =>
    (win[name] as (...a: unknown[]) => unknown)(...args)
  expect(call('alert', 'hi')).toBeUndefined()
  expect(call('confirm', 'ok?')).toBe(false)
  expect(call('prompt', 'password?')).toBeNull()
  expect(native.alert).not.toHaveBeenCalled()
  expect(native.confirm).not.toHaveBeenCalled()
  expect(native.prompt).not.toHaveBeenCalled()
})

test('the no-ops cannot be deleted, overwritten or redefined', () => {
  const { win, native } = boot()
  for (const name of ['alert', 'confirm', 'prompt']) {
    expect(Reflect.deleteProperty(win, name), `delete ${name}`).toBe(false)
    expect(Reflect.set(win, name, native.alert), `assign ${name}`).toBe(false)
    expect(Reflect.defineProperty(win, name, { value: native.alert }), `redefine ${name}`).toBe(
      false
    )
    expect(win[name], `${name} still ours`).not.toBe(native[name as keyof typeof native])
  }
})
