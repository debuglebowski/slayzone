import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TokenCipher } from './hub-tokens'
import { readVoiceKeys, setVoiceKey, voiceKeyStatus } from './voice-keys'

/** Reversible stand-in for safeStorage. */
const cipher: TokenCipher = {
  isEncryptionAvailable: async () => true,
  encryptString: async (plain) => Buffer.from(`enc:${plain}`),
  decryptString: async (c) => ({ result: c.toString().slice(4), shouldReEncrypt: false })
}

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'voice-keys-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('voice keys', () => {
  it('stores encrypted, reports status, decrypts for the engine, clears', async () => {
    const dir = tmp()
    expect(voiceKeyStatus(dir)).toEqual({})
    await setVoiceKey(dir, cipher, 'elevenlabs', '  sk-secret  ')
    const onDisk = readFileSync(join(dir, 'client.voice-keys.json'), 'utf8')
    expect(onDisk).not.toContain('sk-secret')
    expect(voiceKeyStatus(dir)).toEqual({ elevenlabs: true })
    expect(await readVoiceKeys(dir, cipher)).toEqual({ elevenlabs: 'sk-secret' })
    await setVoiceKey(dir, cipher, 'elevenlabs', '')
    expect(voiceKeyStatus(dir)).toEqual({})
  })

  it('refuses to store a key without secure storage', async () => {
    const none: TokenCipher = { ...cipher, isEncryptionAvailable: async () => false }
    await expect(setVoiceKey(tmp(), none, 'elevenlabs', 'k')).rejects.toThrow('no secure storage')
  })
})
