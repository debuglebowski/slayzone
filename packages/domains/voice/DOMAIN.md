# Voice (conversation mode)

Hands-free talk with a task's chat agent. English, headphones only (no echo
cancellation, no speaker support), no push-to-talk. Voice I/O runs on the
client; the agent (on whatever computer) only ever sees and sends text.

```
mic → VAD (Silero) → STT per speech segment (Parakeet TDT 0.6B v3)
    → turn buffer → on each pause: end keyword as the LAST word + ≥300 ms silence?
    → strip keyword, send through the chat's own sendMessage
chat's agent events → reply text (live deltas) → no-speak gate → sentences
    → TTS per sentence (Pocket TTS) → playback queue
```

## Layout

| Folder | What | Runs on |
|---|---|---|
| `src/shared/` | Provider interfaces (`SttProvider`, `TtsProvider`, `VadProvider`), `TurnDetector` (keyword, "scratch that", tone + timeout fallback), `SentenceChunker`, `NoSpeakGate`, `ReplyPlaybackTracker` + interruption note, `ReplyStreamReader` (AgentEvent → reply text), `SpeechQueue`, `SpeechInput` (VAD+STT), `VoiceLoop`, model manifest, engine protocol | anywhere — no DOM/Node/Electron imports; the React Native client reuses it |
| `src/engine/` | sherpa-onnx providers (`SileroVad`, `ParakeetStt`, `PocketTts` (default), `KokoroTts`) and the engine host | the voice utility process (desktop) |
| `src/client/` | `useVoiceMode`, `VoiceModeButton`, `VoiceSession`, mic AudioWorklet, Web Audio sink, engine client | renderer |
| `scripts/` | `models` (fetch pinned models), `bench` (offline keyword + latency bench) | dev |

## Desktop process model

Main (`apps/app/src/main/voice-host.ts`) forks ONE utility process
(`voice-engine.js`) on first use and only brokers: per renderer session it makes
two `MessageChannelMain`s (control, audio) and hands one end of each to the
engine, the other to the renderer (preload → `window.postMessage` with ports).
The mic AudioWorklet posts 16 kHz PCM straight to the engine; no audio work on
the UI thread or main. Models load once per engine and are shared by sessions.
The loop's clock is the engine's `tick` (every 50 ms of mic audio), not a renderer
timer: hands-free use is mostly with the window hidden, where timers are throttled
to 1 Hz but port messages are not.

## Contracts

- **Chat path**: voice uses the chat panel's own `useChatSession` —
  `sendMessage(text, { id })` and `subscribeEvents` (the events the timeline
  applies). The id it mints is the turn's `execution.messageId`, which is how a
  reply is attributed to voice; a turn without `messageId` is unprompted.
- **Turn text**: first voice turn of a session carries `VOICE_PRIMER` (spoken
  style, the `[no-speak]` token, what interruption notes mean); later turns
  `[voice]`. A barge-in note `[interrupted during sentence N: "…"; later
  sentences were not heard]` is prepended to the next turn.
- **Unprompted replies** are held while the user is mid-turn (speaking, being
  transcribed, or unsent words), then spoken.
- **Barge-in**: speech while reply audio plays or waits stops playback and
  synthesis, mutes the rest of that agent turn, and never interrupts the agent.
- **Settings**: `voice` settings key (JSON, `parseVoiceSettings`): `endKeyword`
  (default "over"), `discardKeyword` ("scratch that"), `keywordSilenceMs` (300),
  `fallbackToneMs` (8000), `fallbackEndMs` (2000).
- **Models**: `<client root>/voice-models` (`~/.slayzone/<dev|stable>/client/`),
  the future downloadable module's location; never bundled.
  `pnpm --filter @slayzone/voice models` fetches them meanwhile.

## Dependencies

`terminal-contracts` (AgentEvent), `transport` (voice host accessor, typed tRPC),
`platform` (bootstrap contract, client root), `settings-core`, `ui`.
`sherpa-onnx-node@2.0.1` (pinned; N-API, prebuilt per platform; unpacked from asar).

## Decision Log

**2026-11-27: sherpa-onnx-node 2.0.1, not 2.0.3**
2.0.3 is younger than the workspace's 14-day release-age gate; 2.0.1 has the same
API and passed the same VAD/Parakeet/Kokoro round trip.

**2026-11-27: Utility process + direct MessagePorts**
Off the UI thread and off main; a native crash kills only the engine (restarted on
the next connect). Ports skip main for every PCM frame.

**2026-11-27: Turn prefix instead of a system prompt**
The chat has no per-agent system-prompt hook; a one-time primer plus a `[voice]`
tag survives compaction and needs no agent restart. Revisit when a prompt hook exists.

**2026-11-27: Pocket TTS is the default, not Kokoro**
sherpa-onnx 2.x dropped espeak-ng, so Kokoro only says lexicon words and silently skips
the rest ("linter", "config", "websocket", identifiers) — fatal for technical replies.
Pocket has no lexicon and says them; ~20–30% slower on long sentences, faster on short
ones. Kokoro stays an optional provider.

**2026-11-27: Bring-your-own-key cloud voice: ElevenLabs only**
Chosen in the voice settings popover (beside the mic). The key is stored encrypted
with safeStorage in `<client root>/client.voice-keys.json` (main, `voice-keys.ts`),
decrypted per session for the engine only; renderers can set/clear it and see whether
one is set, never read it. `eleven_flash_v2_5`, raw PCM 24 kHz, voice id configurable
(premade voices end 2026-12-31). OpenAI left out: `/v1/audio/speech` models retire
2027-01-06 and the replacement is Realtime-API only. Not yet run against the live API.
