/**
 * Every test file that drives the chat transport loads the strict lifecycle
 * check (`chat-lifecycle-strict-testkit.ts`, directly or via the transport
 * test kit), so a model / runtime disagreement can never pass silently.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const dir = fileURLToPath(new URL('.', import.meta.url))

test('every transport test file fails on a lifecycle disagreement', () => {
  const missing = readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => {
      const src = readFileSync(dir + f, 'utf8')
      return (
        src.includes("'./chat-transport-manager'") &&
        !src.includes("'./chat-lifecycle-strict-testkit'") &&
        !src.includes("'./chat-transport-testkit'")
      )
    })
  expect(missing).toEqual([])
})
