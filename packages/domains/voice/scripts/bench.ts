/**
 * Offline voice-loop bench (no mic, no app): ~10 min of synthetic technical talk
 * → Silero VAD → Parakeet STT → TurnDetector, on a simulated clock, with the
 * real models. Reports keyword hits / misses / false fires and the input-side
 * latency; then TTS latency for Pocket TTS and Kokoro. Needs `models --all`:
 * the synthetic talk is rendered with Kokoro's 11 voices.
 *
 *   pnpm --filter @slayzone/voice bench [--dir <models>] [--minutes 10] [--seed 7]
 *
 * Talk is Kokoro speech (11 voices, varied speed) plus a low noise floor, with
 * natural pauses: short between sentences, some long mid-thought ones (3–7 s),
 * a few turns where the keyword is forgotten (fallback path). STT wall time is
 * measured for real and added to the simulated clock.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getClientRoot } from '@slayzone/platform'
import {
  DEFAULT_TURN_DETECTOR_CONFIG,
  percentile,
  TurnDetector,
  VOICE_MODELS_DIRNAME,
  VOICE_SAMPLE_RATE,
  type TtsProvider,
  type TurnDecision
} from '../src/shared'
import { KokoroTts, ParakeetStt, PocketTts, SileroVad } from '../src/engine/sherpa-providers'
import { KEYWORD_ENDINGS, NATURAL_FINAL_OVER, TALK } from './bench-corpus'

const args = process.argv.slice(2)
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const modelsDir = arg('dir', join(getClientRoot(), VOICE_MODELS_DIRNAME))
const minutes = Number(arg('minutes', '10'))
const seed = Number(arg('seed', '7'))
const cacheDir = arg('cache', '/tmp/slayzone-voice-bench')
const minSilenceMs = Number(arg('min-silence', '150'))
const maxSpeechS = Number(arg('max-speech', '20'))
const tailPadS = Number(arg('pad', '0.1'))
const skipTts = args.includes('--no-tts')
const preRollMs = Number(arg('pre-roll', '0'))
const SR = VOICE_SAMPLE_RATE

// ---- seeded randomness -------------------------------------------------------

let rngState = seed >>> 0 || 1
function rand(): number {
  rngState ^= rngState << 13
  rngState ^= rngState >>> 17
  rngState ^= rngState << 5
  return (rngState >>> 0) / 0x1_0000_0000
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
const between = (a: number, b: number): number => a + rand() * (b - a)

// ---- the script of the session -----------------------------------------------

interface Utterance {
  text: string
  turn: number
  /** Ends the turn with the keyword. */
  keyword: boolean
  /** A sentence whose natural last word is "over" (not meant as the keyword). */
  naturalOver: boolean
  /** Silence after it, seconds. */
  pauseAfter: number
  sid: number
  speed: number
}

function script(): Utterance[] {
  const ordinary = TALK.filter((t) => !NATURAL_FINAL_OVER.has(t))
  const naturalFinal = [...NATURAL_FINAL_OVER]
  const out: Utterance[] = []
  const targetSentences = Math.round((minutes * 60) / 3.6)
  let turn = 0
  while (out.length < targetSentences) {
    turn++
    const sid = Math.floor(rand() * 11)
    const speed = between(0.9, 1.1)
    const n = 1 + Math.floor(rand() * 5)
    const sentences: Array<{ text: string; naturalOver: boolean }> = []
    for (let i = 0; i < n; i++) sentences.push({ text: pick(ordinary), naturalOver: false })
    // Spread the natural sentence-final "over"s through the session, mid-turn.
    if (naturalFinal.length > 0 && n >= 2 && rand() < 0.25) {
      sentences.splice(Math.floor(rand() * (n - 1)), 0, {
        text: naturalFinal.pop()!,
        naturalOver: true
      })
    }
    const forgot = rand() < 0.07
    if (!forgot) {
      const last = sentences.pop()!
      const ending = pick(KEYWORD_ENDINGS)(last.text)
      for (const text of ending) sentences.push({ text, naturalOver: false })
    }
    sentences.forEach((s, i) => {
      const lastOfTurn = i === sentences.length - 1
      const longPause = rand() < 0.12
      out.push({
        text: s.text,
        turn,
        keyword: lastOfTurn && !forgot,
        naturalOver: s.naturalOver,
        // Mid-turn: a breath, sometimes a long think. After the turn: the agent
        // "replies" (12–20 s, longer than the 8+2 s fallback when forgotten).
        pauseAfter: lastOfTurn ? between(12, 20) : longPause ? between(3, 7) : between(0.35, 1.4),
        sid,
        speed
      })
    })
  }
  return out
}

// ---- audio --------------------------------------------------------------------

interface Placed extends Utterance {
  startSample: number
  endSample: number
}

async function render(
  utts: Utterance[],
  tts: KokoroTts
): Promise<{ pcm: Float32Array; placed: Placed[] }> {
  const key = `talk-${seed}-${minutes}`
  const pcmPath = join(cacheDir, `${key}.f32`)
  const metaPath = join(cacheDir, `${key}.json`)
  if (existsSync(pcmPath) && existsSync(metaPath)) {
    const buf = readFileSync(pcmPath)
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    return {
      pcm: new Float32Array(pcm),
      placed: JSON.parse(readFileSync(metaPath, 'utf8')) as Placed[]
    }
  }
  const chunks: Float32Array[] = []
  const placed: Placed[] = []
  let cursor = Math.round(1.0 * SR)
  chunks.push(new Float32Array(cursor))
  const ctl = new AbortController()
  let i = 0
  for (const u of utts) {
    const { pcm, sampleRate } = await synthAt(tts, u, ctl.signal)
    const speech = trimSilence(resample(pcm, sampleRate, SR))
    chunks.push(speech)
    placed.push({ ...u, startSample: cursor, endSample: cursor + speech.length })
    cursor += speech.length
    const gap = Math.round(u.pauseAfter * SR)
    chunks.push(new Float32Array(gap))
    cursor += gap
    if (++i % 20 === 0) process.stdout.write(`  rendered ${i}/${utts.length}\n`)
  }
  const pcm = new Float32Array(cursor)
  let off = 0
  for (const c of chunks) {
    pcm.set(c, off)
    off += c.length
  }
  // Noise floor (~ -54 dBFS): a quiet room, not digital silence.
  for (let k = 0; k < pcm.length; k++) pcm[k] += (rand() * 2 - 1) * 0.002
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(pcmPath, Buffer.from(pcm.buffer))
  writeFileSync(metaPath, JSON.stringify(placed))
  return { pcm, placed }
}

function synthAt(tts: KokoroTts, u: Utterance, signal: AbortSignal) {
  return tts.synthesize(u.text, signal, { sid: u.sid, speed: u.speed })
}

function resample(pcm: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return pcm
  const n = Math.floor((pcm.length * to) / from)
  const out = new Float32Array(n)
  const ratio = from / to
  for (let i = 0; i < n; i++) {
    const x = i * ratio
    const a = Math.floor(x)
    const b = Math.min(a + 1, pcm.length - 1)
    out[i] = pcm[a] + (pcm[b] - pcm[a]) * (x - a)
  }
  return out
}

function trimSilence(pcm: Float32Array): Float32Array {
  let s = 0
  let e = pcm.length
  while (s < e && Math.abs(pcm[s]) < 0.01) s++
  while (e > s && Math.abs(pcm[e - 1]) < 0.01) e--
  return pcm.subarray(Math.max(0, s - 160), Math.min(pcm.length, e + 160))
}

// ---- the pipeline on a simulated clock ----------------------------------------

interface Fired {
  decision: TurnDecision
  at: number
}

async function run(pcm: Float32Array, stt: ParakeetStt) {
  const vad = new SileroVad(modelsDir, { minSilenceMs, maxSpeechS, preRollMs })
  const detector = new TurnDetector({ ...DEFAULT_TURN_DETECTOR_CONFIG })
  const due: Array<{ at: number; fn: () => void }> = []
  const fired: Fired[] = []
  const segments: Array<{
    endAt: number
    detectedAt: number
    transcribedAt: number
    text: string
    sttMs: number
  }> = []
  let simMs = 0
  let lastTranscriptAt = 0
  const pendingStt: Array<{ pcm: Float32Array; endAt: number; detectedAt: number }> = []
  vad.onSpeechStart(() => due.push({ at: simMs, fn: () => detector.speechStarted() }))
  vad.onSegment((seg) => {
    const endAt = (seg.endSample / SR) * 1000
    detector.speechEnded(endAt)
    pendingStt.push({ pcm: seg.pcm, endAt, detectedAt: simMs })
  })
  const WINDOW = 512
  for (let off = 0; off + WINDOW <= pcm.length; off += WINDOW) {
    simMs = ((off + WINDOW) / SR) * 1000
    vad.accept(pcm.subarray(off, off + WINDOW))
    while (pendingStt.length > 0) {
      const p = pendingStt.shift()!
      const t0 = performance.now()
      const text = await stt.transcribeSegment(p.pcm, SR)
      const sttMs = performance.now() - t0
      // One STT at a time: a segment waits for the one before it.
      const at = Math.max(p.detectedAt, lastTranscriptAt) + sttMs
      lastTranscriptAt = at
      segments.push({ endAt: p.endAt, detectedAt: p.detectedAt, transcribedAt: at, text, sttMs })
      due.push({ at, fn: () => detector.transcript(text, at) })
    }
    due.sort((a, b) => a.at - b.at)
    while (due.length > 0 && due[0].at <= simMs) due.shift()!.fn()
    const d = detector.tick(simMs)
    if (d.kind !== 'none') fired.push({ decision: d, at: simMs })
  }
  return { fired, segments }
}

// ---- scoring --------------------------------------------------------------------

function score(placed: Placed[], fired: Fired[]) {
  const turns = new Map<number, Placed[]>()
  for (const p of placed) turns.set(p.turn, [...(turns.get(p.turn) ?? []), p])
  const keywordTurns = [...turns.values()].filter((t) => t.at(-1)!.keyword)
  const forgotTurns = [...turns.values()].filter((t) => !t.at(-1)!.keyword)
  const ends = fired.filter((f) => f.decision.kind === 'end')
  const used = new Set<Fired>()
  const hits: Array<{ turn: Placed[]; fire: Fired; keywordEndMs: number }> = []
  const misses: Array<{ turn: Placed[]; got: string }> = []
  for (const t of keywordTurns) {
    const last = t.at(-1)!
    const keywordEndMs = (last.endSample / SR) * 1000
    const fire = ends.find(
      (f) =>
        !used.has(f) &&
        f.decision.kind === 'end' &&
        f.decision.reason === 'keyword' &&
        f.at >= keywordEndMs &&
        f.at <= keywordEndMs + 3000
    )
    if (fire) {
      used.add(fire)
      hits.push({ turn: t, fire, keywordEndMs })
    } else {
      const near = ends.find(
        (f) => !used.has(f) && f.at >= keywordEndMs && f.at <= keywordEndMs + 12_000
      )
      misses.push({
        turn: t,
        got:
          near && near.decision.kind === 'end'
            ? `${near.decision.reason}: "…${near.decision.text.slice(-60)}"`
            : 'nothing'
      })
    }
  }
  const falseFires = ends.filter(
    (f) => !used.has(f) && f.decision.kind === 'end' && f.decision.reason === 'keyword'
  )
  const timeouts = ends.filter((f) => f.decision.kind === 'end' && f.decision.reason === 'timeout')
  const naturalOver = placed.filter((p) => p.naturalOver)
  const naturalOverFired = naturalOver.filter((p) => {
    const endMs = (p.endSample / SR) * 1000
    return falseFires.some((f) => f.at >= endMs && f.at <= endMs + 2000)
  })
  return {
    keywordTurns,
    forgotTurns,
    hits,
    misses,
    falseFires,
    timeouts,
    naturalOver,
    naturalOverFired
  }
}

const fmt = (xs: number[]): string =>
  xs.length
    ? `p50 ${percentile(xs, 50).toFixed(0)} ms, p95 ${percentile(xs, 95).toFixed(0)} ms (n=${xs.length})`
    : 'n/a'

// ---- TTS latency ------------------------------------------------------------------

const REPLY_SENTENCES = [
  'Done.',
  'The build passed.',
  'I found the problem in the session refresh logic.',
  'The token was compared against the wrong clock, so it expired early.',
  'I changed the comparison to use the server time and added a test for the boundary case.',
  'Three files changed: the auth middleware, its test, and the shared clock helper, which now exposes the server offset so other callers can use it too.',
  'The slowest end to end spec waited on a fixed five second timeout before checking the sidebar; I replaced it with a wait for the element, which brings that spec from nine seconds down to just over two.'
]

async function benchTts(label: string, tts: TtsProvider): Promise<void> {
  const ctl = new AbortController()
  await tts.synthesize('Warm up.', ctl.signal)
  console.log(`\n${label}`)
  const all: number[] = []
  for (const s of REPLY_SENTENCES) {
    const runs: number[] = []
    let audioS = 0
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now()
      const out = await tts.synthesize(s, ctl.signal)
      runs.push(performance.now() - t0)
      audioS = out.pcm.length / out.sampleRate
    }
    all.push(...runs)
    const med = percentile(runs, 50)
    console.log(
      `  ${String(s.length).padStart(3)} chars → ${audioS.toFixed(1)} s audio: synth ${med.toFixed(0)} ms (RTF ${(med / 1000 / audioS).toFixed(2)})`
    )
  }
  console.log(`  all sentences: ${fmt(all)}`)
}

// ---- main -------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`models: ${modelsDir}`)
  const kokoro = await KokoroTts.load(modelsDir)
  const stt = await ParakeetStt.load(modelsDir, { tailPadS })
  console.log(
    `vad min silence ${minSilenceMs} ms, max speech ${maxSpeechS} s; stt tail pad ${tailPadS} s`
  )

  const utts = script()
  console.log(
    `session: ${utts.length} utterances, ${new Set(utts.map((u) => u.turn)).size} turns (seed ${seed})`
  )
  const { pcm, placed } = await render(utts, kokoro)
  const speechS = placed.reduce((s, p) => s + (p.endSample - p.startSample), 0) / SR
  console.log(
    `audio: ${(pcm.length / SR / 60).toFixed(1)} min total, ${(speechS / 60).toFixed(1)} min of speech`
  )

  const t0 = performance.now()
  const { fired, segments } = await run(pcm, stt)
  const wallS = (performance.now() - t0) / 1000
  const r = score(placed, fired)

  console.log(
    `\nKEYWORD ("${DEFAULT_TURN_DETECTOR_CONFIG.endKeyword}", ${DEFAULT_TURN_DETECTOR_CONFIG.keywordSilenceMs} ms silence)`
  )
  console.log(
    `  keyword turns: ${r.keywordTurns.length}, hits ${r.hits.length}, misses ${r.misses.length}`
  )
  console.log(
    `  false fires: ${r.falseFires.length} (natural sentence-final "over": ${r.naturalOverFired.length} of ${r.naturalOver.length} fired)`
  )
  for (const f of r.falseFires) {
    if (f.decision.kind === 'end')
      console.log(`    false fire @${(f.at / 1000).toFixed(1)}s: "…${f.decision.text.slice(-70)}"`)
  }
  for (const m of r.misses)
    console.log(`    miss turn ${m.turn[0].turn} ("…${m.turn.at(-1)!.text.slice(-40)}") → ${m.got}`)
  console.log(
    `  forgotten-keyword turns: ${r.forgotTurns.length}, timeouts fired: ${r.timeouts.length}`
  )
  console.log(
    `  tones: ${fired.filter((f) => f.decision.kind === 'tone').length}, discards: ${fired.filter((f) => f.decision.kind === 'discard').length}`
  )

  console.log('\nINPUT LATENCY (from the end of the spoken keyword)')
  console.log(
    `  VAD segment closed:  ${fmt(
      r.hits
        .map(
          (h) => segments.find((s) => Math.abs(s.endAt - h.keywordEndMs) < 400)?.detectedAt ?? NaN
        )
        .map((d, i) => d - r.hits[i].keywordEndMs)
        .filter(Number.isFinite)
    )}`
  )
  console.log(
    `  STT done:            ${fmt(r.hits.map((h) => (h.fire.decision.kind === 'end' ? h.fire.decision.transcribedAt : NaN) - h.keywordEndMs))}`
  )
  console.log(`  turn sent:           ${fmt(r.hits.map((h) => h.fire.at - h.keywordEndMs))}`)
  console.log(`  STT per segment:     ${fmt(segments.filter((s) => s.text).map((s) => s.sttMs))}`)
  console.log(
    `  pipeline wall time ${wallS.toFixed(0)} s for ${(pcm.length / SR).toFixed(0)} s of audio`
  )

  if (skipTts) return
  await benchTts(
    'TTS: Pocket TTS (int8, reference voice bria) — default',
    await PocketTts.load(modelsDir)
  )
  await benchTts('TTS: Kokoro 82M (en v0.19)', kokoro)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
