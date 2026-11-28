# Voice loop spike — report (2026-11-27)

Hands-free conversation mode in a task's chat, all on-device. The design is in
`packages/domains/voice/DOMAIN.md`.

## Status

| Done-when | State |
|---|---|
| Multi-turn hands-free conversation on desktop | Works in the built app. The e2e `e2e/chat/187-chat-voice-mode.spec.ts` drives it with the real models, a fake mic and the scripted agent; it passed 3 of 3 runs. |
| Barge-in stops playback and the agent gets the cut-off note | Works. Turn 2 arrived as `[voice]\n[interrupted during sentence 2: "…"; later sentences were not heard]\nStop, just give me the short version.` |
| Provider interfaces with local implementations | `SttProvider` / `TtsProvider` / `VadProvider` in `voice/src/shared`. Local implementations: Silero VAD, Parakeet TDT v3, Kokoro, plus Pocket TTS as an option. |
| Report | This file. |

**Not tested:**
- A real microphone or human voices. This box has no audio hardware; all speech was Kokoro-synthesized.
- A real agent. The agent was the scripted fake.
- macOS, Windows, and packaged builds (asar unpack, mic entitlement).

## Latency

Times are milliseconds after the end of the spoken keyword.

**Input side.** Offline bench (`pnpm --filter @slayzone/voice bench`): 10.9 min of speech, 63 keyword turns, real models, 8-core Xeon, STT wall time measured.

| Stage | p50 | p95 |
|---|---|---|
| VAD closes the segment | 474 | 547 |
| STT done | 839 | 1304 |
| Turn sent | 864 | 1313 |

**Output side, in the app.** The e2e run: 8 turns, fake agent that answers instantly. These stages are measured from the VAD's segment end, which comes after the true end of speech. Add about 250 ms to read them as "from the keyword".

| Stage | p50 | p95 |
|---|---|---|
| STT done | ~225 | 234 |
| Turn sent | 310 | 340 |
| Agent's first token (fake agent, so mostly IPC) | 469 | 620 |
| First complete sentence | 528 | 621 |
| First audio out | 1242 | 1460 |
| TTS of the first sentence alone | 721 | 928 |

**Estimate with a real agent.** From the keyword to the first audio: about 0.9 s, plus the agent's time to first token, plus about 0.8 s. I did not measure the agent's time to first token.

**TTS per sentence:**

| Engine | Synthesis time | p50 / p95 | RTF |
|---|---|---|---|
| Kokoro | 430 ms for "Done." up to 3.3 s for a 200-character sentence | 1346 / 3294 | 0.27–0.33 on long sentences |
| Pocket TTS (int8) | 300 ms up to 4.0 s | 1420 / 3981 | 0.36–0.43 |

## Keyword ("over" + 300 ms of silence)

Two bench sessions, 17 min of speech, 106 keyword turns, with the final settings:
- **Hits:** 101.
- **Misses:** 5. Every one was a standalone "Over." heard as "Over here." or "Overhead." The tone + timeout fallback recovered all 5.
- **False fires:** 6. All six came from talk that naturally ends a sentence with "over" ("we start over", "the migration is finally over", "look it over"). 6 of the 8 such sentences fired. No other talk fired.
- **Forgotten keyword:** all 13 turns ended through the tone + timeout.

So false fires come from the keyword word itself, not the mechanism. Their rate in real speech depends on how often you end a sentence with "over". The phrase is configurable (`voice` setting `endKeyword`); "over to you" would avoid this.

## Open issues

1. **Kokoro silently skips words it doesn't know. This is the big one.**
   - sherpa-onnx 2.x removed espeak-ng, so Kokoro only says words in its lexicon.
   - Test sentence: "The linter flagged the dropdown config, so I added backoff to the websocket reconnect in useChatSession."
     - Kokoro: "The flagged the so I added to the reconnect in."
     - Pocket TTS: every word.
   - Options:
     - make Pocket TTS the default (it's ~10–30% slower, and needs a reference voice);
     - pin sherpa-onnx 1.13.8 to get Kokoro's espeak fallback back (then re-check Parakeet v3);
     - extend the lexicon.
   - **Decided 2026-11-27: Pocket TTS is the default.** Kokoro stays an optional provider.
   - **Pocket's own flaw:** it often drops or garbles a sentence's FIRST word. Parakeet heard the first word right in 10–15 of 18 Pocket sentences, against 18 of 18 for Kokoro ("Done. The build passed." → "on. The build passed."). It's random from run to run. Lead silence and text prefixes didn't help.
2. **"over" false fires** (see above). The keyword choice needs a decision.
3. **Keyword-to-send latency is dominated by VAD hangover** (~470 ms). A streaming keyword spotter on the tail (sherpa has `KeywordSpotter`) could cut it. Splitting the first sentence at its first clause would cut time to first audio.
4. **No system-prompt hook for the chat agent.** A one-time voice primer and a `[voice]` tag travel as a prefix on each turn, so they show in the user's chat bubble.
5. **A short "Stop." at the start of a barge-in is sometimes lost** (1 of 3 e2e runs).
6. **Mic audio is copied, not transferred.** A transfer list doesn't survive the hop to Electron's `MessagePortMain`; the engine got an empty object. Copying ~64 KB/s doesn't matter.
7. **No settings UI.** Keywords and timings are read from the `voice` settings key only.
8. **Models aren't packaged yet.** They're fetched with `pnpm --filter @slayzone/voice models` into `~/.slayzone/<dev|stable>/client/voice-models` (the future module location), ~800 MB with Pocket.

## Runtime check

`sherpa-onnx-node@2.0.1` is pinned; 2.0.3 is newer than the repo's 14-day release-age gate. It uses N-API, so it loads in Electron without a rebuild, and prebuilt binaries cover linux/darwin/win.

| Model | Status |
|---|---|
| Silero VAD | Verified |
| Parakeet TDT v3 (`nemo_transducer`, greedy) | Verified |
| Kokoro (lexicon only) | Verified |
| Pocket TTS | Supported (`model.pocket`, zero-shot reference voice); measured above |
| Phonon | Not supported by sherpa-onnx |

## Added after the spike

- **Supertonic 3** provider (local, optional). It led the three-way TTS comparison: 100% of everyday words, 92% of technical words, 58 of 60 first words heard, and 600 ms p50 synthesis.
- **ElevenLabs, bring your own key:** set in the voice settings popover, with the key stored encrypted on the device. Unit-tested against a mocked API; not yet tried with a real key.
