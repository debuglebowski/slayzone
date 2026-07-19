/**
 * Credential storage fallback contract tests. Plaintext is gated on CIPHER
 * AVAILABILITY (a working OS keychain), not the former
 * SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS env flag: encrypt when a cipher works,
 * fall back to plaintext when none exists (headless standalone hub).
 *
 * Run with: npx tsx packages/domains/integrations/src/server/credentials.test.ts
 */
import assert from 'node:assert/strict'
import { readCredential, storeCredential, setCredentialCipher } from './credentials.js'

class FakeDb {
  private store = new Map<string, string>()

  prepare(sql: string): {
    run: (...args: unknown[]) => void
    get: (...args: unknown[]) => { value: string } | undefined
  } {
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

// A fake OS keychain cipher (base64 "encryption" — enough to prove the encrypt
// path is taken and round-trips). `available` toggles isEncryptionAvailable.
function fakeCipher(available: boolean): {
  isEncryptionAvailable: () => boolean
  encryptString: (s: string) => Buffer
  decryptString: (b: Buffer) => string
} {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  }
}

let passed = 0
let failed = 0
async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`)
  }
}

const prevNodeEnv = process.env.NODE_ENV

async function main(): Promise<void> {
  console.log('\ncredentials fallback (cipher-availability gated)')

  // Force the non-test branch so availability — not NODE_ENV=test — is the gate.
  process.env.NODE_ENV = 'development'

  await runTest('encrypts when a working cipher is available', async () => {
    setCredentialCipher(fakeCipher(true))
    const ref = `cred-${crypto.randomUUID()}`
    await storeCredential(db as never, ref, 'secret-enc')
    assert.equal(await readCredential(db as never, ref), 'secret-enc')
  })

  await runTest('falls back to plaintext when NO cipher is wired (headless hub)', async () => {
    setCredentialCipher(null)
    const ref = `cred-${crypto.randomUUID()}`
    await storeCredential(db as never, ref, 'secret-plain')
    assert.equal(await readCredential(db as never, ref), 'secret-plain')
  })

  await runTest('falls back to plaintext when cipher reports unavailable', async () => {
    setCredentialCipher(fakeCipher(false))
    const ref = `cred-${crypto.randomUUID()}`
    await storeCredential(db as never, ref, 'secret-unavail')
    assert.equal(await readCredential(db as never, ref), 'secret-unavail')
  })

  await runTest('reading a plaintext cred is blocked once a working cipher exists', async () => {
    setCredentialCipher(null)
    const ref = `cred-${crypto.randomUUID()}`
    await storeCredential(db as never, ref, 'secret-later-blocked')
    // A working cipher now exists → the stored plaintext is no longer trusted.
    setCredentialCipher(fakeCipher(true))
    await assert.rejects(() => readCredential(db as never, ref))
  })

  setCredentialCipher(null)
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prevNodeEnv

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

await main()
