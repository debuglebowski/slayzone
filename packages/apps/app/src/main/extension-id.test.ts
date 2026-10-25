/**
 * Tests for extensionIdFromManifestKey — Chrome's ID derivation from a manifest key,
 * used to keep one copy per extension (a Web Store install wins over an import of
 * the same extension from another browser).
 *
 * Run with: npx tsx packages/apps/app/src/main/extension-id.test.ts
 */
import { generateKeyPairSync } from 'node:crypto'
import { extensionIdFromManifestKey } from './extension-id'

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
  if (actual !== expected)
    throw new Error(`${label ? `${label}: ` : ''}expected ${expected}, got ${actual}`)
}

// 1Password's published manifest key → its Chrome Web Store ID.
const ONEPASSWORD_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnHpaUll4uWujpAdbIXOQY2WE6hk8PllsYsnoUaj5qHXwv4IB6A9pONqGaTL2KL20u6E6XVhncY6Ae6SQSBQqiIkgjPsiG0NDNsDlju/kzBnfimKFC/bpzOrqFqbhswQHifnet5uHlpG97whTzLO3ka0M5aqB9V9mD/0qVXvNgAVVnSTULH254YqpeCcAhmsKiFZSL6OrOZmCp8kZ/OeOUK9iYWYylL7VcOXVrZf10EPrlaCNXzVk7K35dPuQ7svhA0Pgju3kngB4RLa5Iojhw3IT+B5+m8pisjOSd1oKMrRmhGs7rDhF5IEtAiVxqVp7uOOMPQj3vrbMDAzf7vqLtQIDAQAB'

console.log('extension-id')

test('derives a 32-char a-p id', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const id = extensionIdFromManifestKey(der)
  eq(id.length, 32, 'length')
  eq(/^[a-p]{32}$/.test(id), true, 'alphabet')
  eq(extensionIdFromManifestKey(der), id, 'deterministic')
})

test('different keys give different ids', () => {
  const k = () =>
    generateKeyPairSync('rsa', { modulusLength: 1024 })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64')
  eq(extensionIdFromManifestKey(k()) === extensionIdFromManifestKey(k()), false)
})

test("matches a real extension's Chrome Web Store id", () => {
  eq(extensionIdFromManifestKey(ONEPASSWORD_KEY), 'aeblfdkhhhdcdjpifhhbdiojplfjncoa')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
