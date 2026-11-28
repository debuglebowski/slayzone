import type { AgentEvent } from '@slayzone/terminal-contracts'
import { formatInterruptionNote, ReplyPlaybackTracker } from './interruption'
import type { TurnLatency } from './latency'
import { NO_SPEAK_TOKEN, NoSpeakGate } from './no-speak'
import type { TtsProvider } from './providers'
import { ReplyStreamReader, type ReplyOrigin, type ReplyStreamEvent } from './reply-stream'
import { SentenceChunker } from './sentence-chunker'
import { SpeechQueue, type AudioSink } from './speech-queue'
import {
  DEFAULT_TURN_DETECTOR_CONFIG,
  TurnDetector,
  type TurnDetectorConfig
} from './turn-detector'
import { hasWords } from './words'

/**
 * Sent once, with the first voice turn of a conversation-mode session: how to
 * write for the ear, the no-speak token and the interruption notes. Later turns
 * carry only `VOICE_TAG`. (The chat has no per-agent system prompt to put this
 * in; a turn prefix also survives compaction.)
 */
export const VOICE_PRIMER =
  `[voice mode: I am talking to you hands-free; your replies are read aloud to me. ` +
  `Write replies the way you would say them: short plain sentences, no markdown, ` +
  `tables, code or file paths unless I ask. Start a message with ${NO_SPEAK_TOKEN} ` +
  `when it should not be read aloud. A line like [interrupted during sentence N …] ` +
  `means I cut you off there and did not hear the rest.]`

export const VOICE_TAG = '[voice]'

export type VoiceActivity =
  /** Mic open, nothing going on. */
  | 'listening'
  /** The user is talking or has unsent words. */
  | 'user-turn'
  /** A turn was sent; waiting for the reply. */
  | 'waiting'
  /** Reply audio playing. */
  | 'speaking'

export interface VoiceLoopStatus {
  activity: VoiceActivity
  /** The user's unsent words (the turn buffer). */
  buffer: string
  /** The forgotten-keyword tone sounded; the turn ends soon unless they speak. */
  toneSounded: boolean
  /** A barge-in note waits for the next turn. */
  noteQueued: boolean
}

export interface VoiceLoopOptions {
  config?: TurnDetectorConfig
  now: () => number
  newId: () => string
  tts: TtsProvider
  sink: AudioSink
  /** Hand a finished turn to the chat (the composer's own send path), under `id`. */
  sendTurn: (text: string, id: string) => Promise<void>
  onStatus?: (status: VoiceLoopStatus) => void
  onLatency?: (sample: TurnLatency) => void
  onError?: (message: string) => void
}

interface MessageState {
  origin: ReplyOrigin
  turnKey: string
  gate: NoSpeakGate
  chunker: SentenceChunker
  /** Cut off by a barge-in: the rest of it is never spoken. */
  muted: boolean
  /** Unprompted and the user was mid-turn: sentences wait here. */
  held: string[] | null
  /** Its `message-end` arrived. */
  ended: boolean
}

interface OpenLatency {
  sample: TurnLatency
  keywordAt: number
  claimed: boolean
}

/**
 * The hands-free conversation loop, platform-neutral: speech events and agent
 * events in; chat sends, speech and status out.
 *
 *   speech segments → transcripts → turn buffer → keyword + silence → send
 *   agent reply stream → no-speak gate → sentences → TTS → playback
 *
 * Barge-in: a sound while reply audio plays (or waits to) ducks it at once; once
 * the sound turns out to be words (early probe or its transcript) it stops the
 * reply, drops the rest of it, and prepends where it was cut to the user's next
 * turn. A cough, breath or "hmm" just un-ducks. The agent's turn keeps running —
 * only the speaking stops.
 */
export class VoiceLoop {
  private readonly detector: TurnDetector
  private readonly reader: ReplyStreamReader
  private readonly tracker = new ReplyPlaybackTracker()
  private readonly speech: SpeechQueue
  private readonly messages = new Map<string, MessageState>()
  /** The turn whose sentences the tracker numbers. */
  private spokenTurn: string | null = null
  /** A turn cut off by barge-in: its later messages stay silent. */
  private mutedTurn: string | null = null
  private pendingNote: string | null = null
  private primed = false
  private waitingReply = false
  private playing = false
  private toneSounded = false
  /** A sound started during a reply: playback is ducked until we know if it is words. */
  private bargePending = false
  private latency: OpenLatency | null = null
  private lastStatus = ''
  private disposed = false

  constructor(private readonly opts: VoiceLoopOptions) {
    this.detector = new TurnDetector(opts.config ?? DEFAULT_TURN_DETECTOR_CONFIG)
    this.reader = new ReplyStreamReader((e) => this.onReply(e))
    this.speech = new SpeechQueue(
      opts.tts,
      opts.sink,
      {
        started: (item, at) => {
          this.playing = true
          this.tracker.started(item.index)
          const open = this.latency
          if (open?.claimed && open.sample.firstAudioMs === null) {
            open.sample.firstAudioMs = at - open.keywordAt
            this.finishLatency()
          }
          this.status()
        },
        finished: (item) => {
          this.playing = false
          this.tracker.finished(item.index)
          this.status()
        },
        synthesized: (item, ms) => {
          const open = this.latency
          if (open?.claimed && item.index === 1 && open.sample.firstSynthMs === null) {
            open.sample.firstSynthMs = ms
          }
        },
        error: (_item, err) => opts.onError?.(`Speech failed: ${errorText(err)}`)
      },
      opts.now
    )
  }

  configure(config: TurnDetectorConfig): void {
    this.detector.configure(config)
  }

  // ---- speech input -------------------------------------------------------

  speechStarted(): void {
    this.detector.speechStarted()
    this.toneSounded = false
    if (this.speech.busy() && !this.bargePending) {
      this.bargePending = true
      this.opts.sink.duck(true)
    }
    this.status()
  }

  /** Early words of the speech going on (see `SpeechInputEvents.speechProbe`). */
  speechProbe(text: string): void {
    // No words yet decides nothing: the speech may go on; its transcript decides.
    if (this.bargePending && hasWords(text)) this.confirmBargeIn()
  }

  speechEnded(at: number): void {
    this.detector.speechEnded(at)
    this.status()
  }

  transcript(text: string, at: number): void {
    this.detector.transcript(text, at)
    if (this.bargePending) {
      if (hasWords(text)) this.confirmBargeIn()
      else this.cancelBargeIn()
    }
    this.status()
  }

  /** Poll often (≤ 50 ms): turn ends, the fallback tone, releasing held speech. */
  tick(): void {
    if (this.disposed) return
    const now = this.opts.now()
    const decision = this.detector.tick(now)
    if (decision.kind === 'tone') {
      this.toneSounded = true
      this.opts.sink.tone()
    } else if (decision.kind === 'discard') {
      this.toneSounded = false
    } else if (decision.kind === 'end') {
      this.toneSounded = false
      this.sendTurn(decision.text, decision.reason, decision.speechEndedAt, decision.transcribedAt)
    }
    if (!this.detector.isMidTurn()) this.releaseHeld()
    this.status()
  }

  // ---- agent output -------------------------------------------------------

  agentEvent(event: AgentEvent): void {
    if (this.disposed) return
    this.reader.accept(event)
  }

  dispose(): void {
    this.disposed = true
    this.speech.stop()
  }

  // ---- internals ----------------------------------------------------------

  private sendTurn(
    text: string,
    reason: 'keyword' | 'timeout',
    keywordAt: number,
    transcribedAt: number
  ): void {
    const id = this.opts.newId()
    const lines = [this.primed ? VOICE_TAG : VOICE_PRIMER]
    this.primed = true
    if (this.pendingNote) lines.push(this.pendingNote)
    this.pendingNote = null
    lines.push(text)
    const now = this.opts.now()
    // An earlier turn that never produced audio is reported as it stands.
    if (this.latency) this.finishLatency()
    this.latency = {
      keywordAt,
      claimed: false,
      sample: {
        turnId: id,
        reason,
        sttMs: transcribedAt - keywordAt,
        sentMs: now - keywordAt,
        firstTokenMs: null,
        firstSentenceMs: null,
        firstAudioMs: null,
        firstSynthMs: null
      }
    }
    this.reader.expectVoiceMessage(id)
    this.waitingReply = true
    this.opts.sendTurn(lines.join('\n'), id).catch((err: unknown) => {
      this.waitingReply = false
      this.opts.onError?.(`Could not send: ${errorText(err)}`)
      this.status()
    })
  }

  private onReply(e: ReplyStreamEvent): void {
    switch (e.kind) {
      case 'message-start': {
        const held = e.origin === 'unprompted' && this.detector.isMidTurn() ? [] : null
        this.messages.set(e.messageId, {
          origin: e.origin,
          turnKey: e.turnKey,
          gate: new NoSpeakGate(),
          chunker: new SentenceChunker(),
          muted: this.mutedTurn === e.turnKey,
          held,
          ended: false
        })
        if (e.origin === 'voice') {
          this.waitingReply = false
          if (this.latency && !this.latency.claimed) this.latency.claimed = true
        }
        return
      }
      case 'text': {
        const m = this.messages.get(e.messageId)
        if (!m) return
        const open = this.latency
        if (m.origin === 'voice' && open?.claimed && open.sample.firstTokenMs === null && e.text) {
          open.sample.firstTokenMs = this.opts.now() - open.keywordAt
        }
        this.deliver(m, m.chunker.push(m.gate.push(e.text)))
        return
      }
      case 'message-end': {
        const m = this.messages.get(e.messageId)
        if (!m) return
        const rest = m.gate.end()
        this.deliver(m, [...m.chunker.push(rest), ...m.chunker.flush()])
        m.ended = true
        if (!m.held) this.messages.delete(e.messageId)
        return
      }
      case 'turn-end': {
        if (e.turnKey === this.spokenTurn) this.tracker.complete()
        if (e.turnKey === this.mutedTurn) this.mutedTurn = null
        this.waitingReply = false
        // A turn that ended without any speech (silent reply, tool-only turn).
        if (this.latency?.claimed && !this.speech.busy()) this.finishLatency()
        this.status()
        return
      }
    }
  }

  private deliver(m: MessageState, sentences: string[]): void {
    if (m.muted || sentences.length === 0) return
    if (m.held) {
      m.held.push(...sentences)
      return
    }
    for (const s of sentences) this.speak(s, m.turnKey, m.origin)
  }

  private speak(text: string, turnKey: string, origin: ReplyOrigin): void {
    if (this.spokenTurn !== turnKey || !this.tracker.active()) {
      this.spokenTurn = turnKey
      this.tracker.begin()
    }
    const index = this.tracker.queued(text)
    const open = this.latency
    if (origin === 'voice' && open?.claimed && open.sample.firstSentenceMs === null) {
      open.sample.firstSentenceMs = this.opts.now() - open.keywordAt
    }
    this.speech.enqueue({ text, index })
  }

  private releaseHeld(): void {
    for (const [id, m] of this.messages) {
      if (!m.held) continue
      const sentences = m.held
      m.held = null
      for (const s of sentences) this.speak(s, m.turnKey, m.origin)
      // Its end already arrived while held: nothing more will come for it.
      if (m.ended) this.messages.delete(id)
    }
  }

  private confirmBargeIn(): void {
    this.bargePending = false
    this.opts.sink.duck(false)
    this.bargeIn()
  }

  /** Not words (a cough, a breath, "hmm"): the reply plays on at full volume. */
  private cancelBargeIn(): void {
    this.bargePending = false
    this.opts.sink.duck(false)
  }

  private bargeIn(): void {
    const point = this.tracker.interrupt()
    this.speech.stop()
    this.playing = false
    if (!point) return
    this.pendingNote = formatInterruptionNote(point)
    if (this.spokenTurn) {
      this.mutedTurn = this.spokenTurn
      for (const m of this.messages.values()) if (m.turnKey === this.spokenTurn) m.muted = true
    }
  }

  private finishLatency(): void {
    const open = this.latency
    this.latency = null
    if (open) this.opts.onLatency?.(open.sample)
  }

  private status(): void {
    const activity: VoiceActivity = this.playing
      ? 'speaking'
      : this.detector.isMidTurn()
        ? 'user-turn'
        : this.waitingReply || this.speech.busy()
          ? 'waiting'
          : 'listening'
    const status: VoiceLoopStatus = {
      activity,
      buffer: this.detector.text(),
      toneSounded: this.toneSounded,
      noteQueued: this.pendingNote !== null
    }
    const key = JSON.stringify(status)
    if (key === this.lastStatus) return
    this.lastStatus = key
    this.opts.onStatus?.(status)
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
