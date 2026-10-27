/**
 * Tests for extensionIdFromManifestKey — Chrome's ID derivation from a manifest key,
 * used to keep one copy per extension (a Web Store install wins over an import of
 * the same extension from another browser).
 */
import { describe, expect, test } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { extensionIdFromManifestKey } from './extension-id'

// 1Password's published manifest key → its Chrome Web Store ID.
const ONEPASSWORD_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnHpaUll4uWujpAdbIXOQY2WE6hk8PllsYsnoUaj5qHXwv4IB6A9pONqGaTL2KL20u6E6XVhncY6Ae6SQSBQqiIkgjPsiG0NDNsDlju/kzBnfimKFC/bpzOrqFqbhswQHifnet5uHlpG97whTzLO3ka0M5aqB9V9mD/0qVXvNgAVVnSTULH254YqpeCcAhmsKiFZSL6OrOZmCp8kZ/OeOUK9iYWYylL7VcOXVrZf10EPrlaCNXzVk7K35dPuQ7svhA0Pgju3kngB4RLa5Iojhw3IT+B5+m8pisjOSd1oKMrRmhGs7rDhF5IEtAiVxqVp7uOOMPQj3vrbMDAzf7vqLtQIDAQAB'

describe('extension-id', () => {
  test('derives a 32-char a-p id', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const id = extensionIdFromManifestKey(der)
    expect(id, 'length').toHaveLength(32)
    expect(id, 'alphabet').toMatch(/^[a-p]{32}$/)
    expect(extensionIdFromManifestKey(der), 'deterministic').toBe(id)
  })

  test('different keys give different ids', () => {
    const k = () =>
      generateKeyPairSync('rsa', { modulusLength: 1024 })
        .publicKey.export({ type: 'spki', format: 'der' })
        .toString('base64')
    expect(extensionIdFromManifestKey(k())).not.toBe(extensionIdFromManifestKey(k()))
  })

  test("matches a real extension's Chrome Web Store id", () => {
    expect(extensionIdFromManifestKey(ONEPASSWORD_KEY)).toBe('aeblfdkhhhdcdjpifhhbdiojplfjncoa')
  })
})
