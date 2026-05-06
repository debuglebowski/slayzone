/**
 * Credential storage fallback contract tests
 * Run with: npx tsx packages/domains/integrations/src/server/credentials.test.ts
 */
import assert from 'node:assert/strict'
import { readCredential, storeCredential } from './credentials.js'

class FakeDb {
  private store = new Map<string, string>()

  prepare(sql: string): { run: (...args: unknown[]) => void; get: (...args: unknown[]) => { value: string } | undefined } {
    if (sql.startsWith('INSERT OR REPLACE INTO settings')) {
      return {
        run: (key, value) => {
          this.store.set(String(key), String(value))
        },
        get: () => undefined
      }
    }

    if (sql.startsWith('SELECT value FROM settings')) {
      return {
        run: () => {},
        get: (key) => {
          const value = this.store.get(String(key))
          return value === undefined ? undefined : { value }
        }
      }
    }

    if (sql.startsWith('DELETE FROM settings')) {
      return {
        run: (key) => {
          this.store.delete(String(key))
        },
        get: () => undefined
      }
    }

    throw new Error(`Unhandled SQL in fake DB: ${sql}`)
  }
}

const db = new FakeDb()

function withEnv(
  patch: Partial<Record<'SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS' | 'NODE_ENV', string | undefined>>,
  fn: () => void
): void {
  const prevAllow = process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS
  const prevNodeEnv = process.env.NODE_ENV
  try {
    if (patch.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS === undefined) {
      delete process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS
    } else {
      process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS = patch.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS
    }
    if (patch.NODE_ENV === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = patch.NODE_ENV
    }
    fn()
  } finally {
    if (prevAllow === undefined) delete process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS
    else process.env.SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS = prevAllow
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
  }
}

function runTest(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

console.log('\ncredentials fallback')

runTest('rejects plaintext fallback when not explicitly enabled', () => {
  withEnv(
    { SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS: undefined, NODE_ENV: 'development' },
    () => {
      const ref = `cred-${crypto.randomUUID()}`
      assert.throws(() => storeCredential(db as never, ref, 'secret'))
    }
  )
})

runTest('allows plaintext fallback when explicitly enabled', () => {
  withEnv(
    { SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS: '1', NODE_ENV: 'development' },
    () => {
      const ref = `cred-${crypto.randomUUID()}`
      storeCredential(db as never, ref, 'secret-enabled')
      assert.equal(readCredential(db as never, ref), 'secret-enabled')
    }
  )
})

runTest('blocks reading plain credentials when fallback is disabled later', () => {
  const ref = `cred-${crypto.randomUUID()}`
  withEnv(
    { SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS: '1', NODE_ENV: 'development' },
    () => {
      storeCredential(db as never, ref, 'secret-blocked')
    }
  )

  withEnv(
    { SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS: undefined, NODE_ENV: 'development' },
    () => {
      assert.throws(() => readCredential(db as never, ref))
    }
  )
})

console.log('\nDone')
