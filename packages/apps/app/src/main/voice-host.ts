import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain, MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron'
import { getClientRoot } from '@slayzone/platform'
import {
  isTtsChoice,
  PARAKEET_TDT_V3,
  SILERO_VAD,
  VOICE_MODELS_DIRNAME,
  type CloudTtsProvider
} from '@slayzone/voice/shared'
import { isAppRenderer } from './browser-host-ipc'
import type { TokenCipher } from './hub-tokens'
import { readVoiceKeys, setVoiceKey, voiceKeyStatus } from './voice-keys'

/**
 * The client-local voice engine (conversation mode): speech models run in ONE
 * utility process on this device — never in main, never in a renderer, never on the
 * hub. Main only brokers: per `voice-host:connect` it creates two channels (control,
 * audio), gives one end of each to the engine and the other to the asking renderer.
 * From then on PCM and speech events flow renderer ⇄ engine directly.
 *
 * Started on first use (most sessions never talk), restarted on the next connect if
 * it died. Models live in `<client root>/voice-models` (the future downloadable
 * module's location). Bring-your-own-key cloud voice keys (voice-keys.ts) are
 * decrypted here and handed to the engine with each session — never to a renderer.
 */

let engine: UtilityProcess | null = null

function voiceModelsDir(): string {
  return join(getClientRoot(), VOICE_MODELS_DIRNAME)
}

function ensureEngine(): UtilityProcess {
  if (engine) return engine
  const child = utilityProcess.fork(join(__dirname, 'voice-engine.js'), [], {
    serviceName: 'SlayZone Voice',
    stdio: 'inherit'
  })
  child.once('exit', (code) => {
    if (engine === child) engine = null
    if (code !== 0) console.warn(`[voice] engine exited with code ${code}`)
  })
  engine = child
  return child
}

function isCloudProvider(value: unknown): value is CloudTtsProvider {
  return isTtsChoice(value) && value === 'elevenlabs'
}

export function registerVoiceHostIpc(cipher: TokenCipher | null): void {
  const keysDir = getClientRoot()
  ipcMain.on('voice-host:connect', (e, requestId: unknown) => {
    if (typeof requestId !== 'string' || !isAppRenderer(e.sender)) return
    const sender = e.sender
    void readVoiceKeys(keysDir, cipher).then((keys) => {
      if (sender.isDestroyed()) return
      const control = new MessageChannelMain()
      const audio = new MessageChannelMain()
      ensureEngine().postMessage({ type: 'connect', modelsDir: voiceModelsDir(), keys }, [
        control.port1,
        audio.port1
      ])
      sender.postMessage('voice-host:ports', requestId, [control.port2, audio.port2])
    })
  })
  ipcMain.handle('voice-host:set-key', async (e, provider: unknown, key: unknown) => {
    if (!isAppRenderer(e.sender)) throw new Error('voice host: not an app renderer')
    if (!isCloudProvider(provider) || typeof key !== 'string')
      throw new Error('voice host: bad key')
    await setVoiceKey(keysDir, cipher, provider, key)
  })
  // Voice needs the speech models on this device (the downloadable module); without
  // them the UI offers no conversation mode at all.
  ipcMain.handle('voice-host:available', (e) => {
    if (!isAppRenderer(e.sender)) throw new Error('voice host: not an app renderer')
    const dir = voiceModelsDir()
    return [SILERO_VAD, PARAKEET_TDT_V3].every((spec) =>
      spec.files.every((f) => existsSync(join(dir, f.installed)))
    )
  })
  ipcMain.handle('voice-host:key-status', (e) => {
    if (!isAppRenderer(e.sender)) throw new Error('voice host: not an app renderer')
    return voiceKeyStatus(keysDir)
  })
}

export function stopVoiceEngine(): void {
  engine?.kill()
  engine = null
}
