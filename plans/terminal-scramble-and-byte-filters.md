# Terminal glyph scramble + 9 byte-filter defects

Two independent problem sets found by the deep-dive. **P0 is the scramble** (upstream already
fixed it). P1–P3 are separate real defects found while clearing the byte stream as a suspect.
Every claim below was verified locally; provenance noted per item.

---

## P0 — Glyph scramble: bump xterm to the beta that fixes it

### Root cause (proven live over CDP, 2026-07-29)

`CharAtlasCache.ts` keeps a **module-level** cache: terminals with equal font/size/DPR/theme
share ONE `TextureAtlas` object. Live measurement: 6 xterms, 4 on WebGL, **1 distinct atlas**.
`correctAtlas()` calls `addon.clearTextureAtlas()` → `_charAtlas.clearTexture()` wipes and
**repacks the shared atlas**, then `_clearModel(true)` rebuilds vertex data — but only for the
**calling** renderer. Siblings keep `a_texcoord`/`a_texpage` pointing at pre-repack tiles and
paint old coords against new tiles.

**Siblings receive no invalidation signal at all — not a lost race.** Read from the installed
`node_modules/@xterm/addon-webgl/src/TextureAtlas.ts`: `clearTexture()` (`:141-151`) clears every
page + both cache maps and sets **no flag**. `_requestClearModel` is assigned in exactly two other
places — `:209` (page merge) and `:821` (overflow-glyph page) — neither on our path. The calling
pane recovers only because `WebglRenderer.clearTextureAtlas()` separately calls `_clearModel(true)`
on itself. So a shared-atlas sibling is never told, and stays broken until a resize. (An earlier
draft of this plan said recovery "reaches exactly one of N renderers" — that describes the
page-merge path, where the one-shot `beginFrame()` is consumed by the first caller. On the
`clearTexture()` path it reaches **none**.)

**Why the user reports "absolutely NO PATTERN".** Two mechanisms compound:
1. `AtlasPage.clear()` **does** bump `version` (`:1100`, `version = ++AtlasPage.nextVersion`), so
   `GlyphRenderer.render` sees a version change and dutifully re-uploads the newly-repacked tile
   textures — while the sibling's vertex buffer still holds pre-repack texcoords. New tiles,
   old coordinates: garbage glyphs on a correct layout.
2. `_updateModel(start, end)` refreshes only **changed** lines. A pane with output scrolling
   through it silently self-heals the lines that change and leaves static lines scrambled.

→ partial, per-line, non-reproducible garbage whose extent depends on which lines happened to
repaint. Diagnosis and symptom match on the same mechanism.

Oracle (read-only): reverse-map `page|texCoordX|texCoordY → chars` from `atlas._cacheMap`, decode
`gr._vertices.attributes` (stride **11**), compare painted glyph vs buffer text per cell. Healthy
pane 100% agree; scrambled 0.1% (buffer `Claude Code v2.1.220` painted `????$? ??$? ????????`).
`renderer.handleResize(cols, rows)` on every pane → all back to 100%. That is why any user resize
repairs the screen.

### Upstream fixed it

xterm.js issue **#6014** = this exact bug (VS Code's per-terminal `clearTextureAtlas()` on OS
resume — structurally identical to our heartbeat). PR **#6055** merged 2026-07-27, plus **#6042**
(`pageLayoutVersion`) and **#6043** (page cap).

Verified by unpacking tarballs:

| | installed `-beta.219` | target `-beta.291` |
|---|---|---|
| invalidation signal in `clearTexture()` | **none** | `_pageLayoutVersion++` (:152) |
| `TextureAtlas._pageLayoutVersion` | absent | :135-136, bumped at :152/:213/:277/:846 |
| `GlyphRenderer._lastSeenPageLayoutVersion` | absent | :103, compared in `beginFrame()` :226 |
| `TextureAtlas.beginFrame()` consume-once | :135-138 | replaced by the version getter |
| `grep -c pageLayoutVersion lib/addon-webgl.mjs` | **0** | **2** |

So what we ship today is definitively unfixed. `WebglRenderer.ts` calls
`_glyphRenderer.beginFrame()` at the same two sites in both versions (:374/:386 vs :377/:389) —
only the *answer* changes, from a consume-once per-atlas flag to a per-renderer version compare.
A sibling whose `beginFrame()` now returns `true` runs `_clearModel(true)` +
`_updateModel(0, rows-1)` — a **full** viewport rebuild, which is what makes mechanism 2 above
(stale static lines) go away rather than partially heal.

### Change

`packages/domains/terminal/package.json` — all 8 in lockstep:

```
@xterm/addon-fit                0.12.0-beta.219 → 0.12.0-beta.292
@xterm/addon-search             0.17.0-beta.219 → 0.17.0-beta.292
@xterm/addon-serialize          0.15.0-beta.219 → 0.15.0-beta.292
@xterm/addon-unicode-graphemes   0.5.0-beta.219 →  0.5.0-beta.292
@xterm/addon-webgl              0.20.0-beta.219 → 0.20.0-beta.291   ← current beta dist-tag
@xterm/xterm                     6.1.0-beta.219 →  6.1.0-beta.292
@xterm/headless (devDep)         6.1.0-beta.219 →  6.1.0-beta.292
```

`addon-webgl@0.20.0-beta.291` is the newest published build — **`0.20.0-beta.292` does not exist**
(npm 404; the `beta` dist-tag is `0.20.0-beta.291`). Its peer is `@xterm/xterm ^6.1.0-beta.292`,
which the other six satisfy, so the skew is a `^`-satisfied peer, not a mismatch. But it means
webgl **necessarily trails** the rest by one build. The `//xterm` comment must say so explicitly,
otherwise the next person "restores lockstep" into a 404. Also update it: 7 → 8 packages, and
record that beta.291/292 carries the #6055 shared-atlas fix.

Free fixes riding along in the same bump (all read from the 291 source, none typings-visible):
- `_evictAllPages()` + `TextureAtlas.maxAtlasPages` cap (#6043) — bounds atlas memory growth in a
  long-running many-pane session.
- `clearTimeout(this._contextRestorationTimeout)` on dispose (:162-163) — a real leak fix; relevant
  to the open renderer-retention question.
- null-`bufferLine` guard in `_updateModel` (:459-470) — nulls the row instead of throwing on
  `terminal.buffer.lines.get(row)!`.
- `console.log`/`console.warn` → `ILogService` for the three webglcontextlost/restored paths.

### Typings risk: none

Full `diff` of every `typings/` dir, 219 → target:

- `xterm.d.ts`: **0 removed lines**, +11 additive (`mouseEventsRequireAlt` option).
- `addon-webgl.d.ts`: 2 comment typo fixes ("the a new page" → "a new page"). Public API identical.
- `addon-fit` / `addon-search` / `addon-serialize` / `addon-unicode-graphemes`: byte-identical.
- `headless.d.ts`: `registerMarker()` return **narrowed** `IMarker | undefined` → `IMarker`.
  Narrowing a return type can't break a caller, and `grep registerMarker packages/` = **0 hits**;
  `@xterm/headless` is a devDep with no importer anywhere in `src/`.

→ **zero call-site edits.** `WebglRenderer`'s new `ILogService` ctor arg and null-`bufferLine`
guard are addon-internal.

### P0b — close the second atlas-mutation site

`Terminal.tsx:602-603` calls `cached.webglAddon.clearTextureAtlas()` + `refresh()` inline on the
reattach path, bypassing `correctAtlas()`. Route it through `correctAtlas(cached.webglAddon,
cached.terminal, sessionId)` so every atlas mutation goes through one function with one diag
event. Behaviour-identical (`correctAtlas` is exactly those two calls + `diag`) — but the existing
inline `diag(..., { site: 'reattach' })` label must be preserved, so add an optional `site` arg to
`correctAtlas` rather than dropping the label.

### Explicitly NOT removing

The 30 s heartbeat + `visibilitychange` + `focus` corrections (`Terminal.tsx:1398-1423`) and the
`CORRECTION_DELAYS_MS = [250, 750]` startup window stay. They exist for a **different** real
cause: macOS/Metal silently evicts the atlas texture during GPU idle with no JS-visible signal.
The bump makes them non-destructive to siblings; it does not make them pointless. Removing them
would drop working functionality. Revisit only with live evidence, separately.

**They do NOT bound the repair latency — measured, and this was the plan's one wrong assumption.**
The fix lands on a renderer's next *frame* (`beginFrame()` is only reached from `_renderRows`).
`correctAtlas` does force a frame via `refresh()` — but only on the **mutating** pane, and
`tryCorrect` is gated on `isActiveRef.current`, so the heartbeat repacks the shared atlas while
skipping the inactive panes it just invalidated. Live: panes sat 52 repacks behind (`seen=94` vs
`plv=146`) at 0% agreement across multiple heartbeat ticks and a dispatched `focus`. Worst case is
**unbounded**, not 30 s. This is what P0c fixes; the finding was found, not tolerated.

### Tests (TDD)

1. **New failing-first guard** `packages/domains/terminal/src/client/xterm-atlas-fix.test.ts`:
   reads the installed `@xterm/addon-webgl/lib/addon-webgl.mjs` and asserts it contains
   `pageLayoutVersion`. Run it BEFORE the bump → fails (0 occurrences). After → passes. This is a
   permanent downgrade guard: any future pin that loses the fix goes red.
2. Existing `webgl-loader.test.ts` must stay green (stub-driven, covers `correctAtlas`); extend
   with a case asserting `correctAtlas` forwards the `site` label to `diag`.
3. `pnpm typecheck` (proves the typings analysis above empirically).

### Live verification — ONE bundled restart

`pnpm install` → `pnpm build` → restart dev app. Then, attached over CDP (never bare-launch
`out/main/index.js` — it clobbers the real dev DB):

Steps 1–4 are **DONE** on the restarted app (results in P0c). Step 5 remains, and must be re-run
after P0c lands.

1. ✅ Oracle re-installed. **7 xterms, 7 on WebGL, 1 distinct atlas** — sharing unchanged by the bump.
2. ✅ `clearTextureAtlas()` on one pane, then `refresh()` on each sibling → **all seven at 100%**
   painted-vs-buffer agreement. Pre-bump this same call left a sibling at 0%.
3. ✅ `atlas._pageLayoutVersion` increments per repack; each `gr._lastSeenPageLayoutVersion` catches
   up on that renderer's next frame. Both symbols present in the shipped bundle.
4. ✅ Unforced case measured — **and it does not self-heal.** Inactive panes held `seen=94` against
   `plv=146` (52 repacks) at 0% through multiple heartbeat ticks and a dispatched `focus`.
   Reported as a finding, not tolerated → **P0c**.
5. ⬜ **After P0c:** leave 2+ panes idle (both hidden and visible, since visible-idle is exposed too)
   across ≥2 heartbeat ticks (60 s+) and confirm every pane holds 100% with no user interaction.

Measurement notes for whoever re-runs this:
- The oracle must read `plv` and decode the vertex buffer in **one synchronous pass**. A split read
  straddles a repack and reports a false lag — an earlier run showed `seen` advancing 43→94 while
  `plv` had already moved to 95, which reads as "still broken" when the pane had in fact repaired.
- `INDICES_PER_CELL` is **11**, not 9 (idx 4 = texpage, 5/6 = texcoord, 7/8 = texsize). Stride 9
  produces plausible-looking garbage, including fractional `a_texpage` values, which is the tell.
- Live monkey-patches (`window.__T`, `window.__parts`, `window.__snap`) die on every restart.

### P0c — Broadcast a frame to every sharing pane after an atlas mutation

**Status: REQUIRED. The bump alone does not close the user-visible symptom.** Measured live on the
restarted app (beta.291/292 installed, `plv` + per-renderer `seen` confirmed present).

The bump makes the repair *possible*; it does not make it *happen*. Upstream's fix is consumed in
`GlyphRenderer.beginFrame()`, which is only reached from `WebglRenderer.renderRows` — i.e. **on a
frame**. `correctAtlas()` calls `refresh()` on the *mutating* pane only, so every other pane
sharing the atlas holds stale texcoords until something independently makes it paint.

Live measurement, 7 panes / 1 shared atlas:

```
[1] BASELINE (atomic)
  ti0 visible 100%  plv=146 seen=146      ti3 hidden 0%  plv=146 seen=94   ← 52 repacks behind
  ti1 hidden  100%  plv=146 seen=146      ti4 hidden 0%  plv=146 seen=94
  ti2 hidden  100%  plv=146 seen=146      ti5 hidden 0%  plv=146 seen=93
[2] correctAtlas() on ONE pane → +3.0s: ti3/ti4/ti5 unchanged at 0%, seen still 94/94/93
[3] refresh() on each stale pane (no atlas clear, no resize) → ALL SEVEN 100%
```

Step 3 is the proof the bump works: pre-bump, `refresh()` on a scrambled sibling left it at 0% and
only `handleResize` repaired it. Post-bump a plain frame is sufficient. Confirmed a second way —
writing a single no-op `ESC[0m` to each stale pane took `lag` 14→0 and every pane to 100%.

**Correcting an earlier statement of mine:** I said a visible pane "paints continuously" so only
hidden panes could stay scrambled. That is wrong and the distinction matters for the fix. xterm
paints on *change*, not on a clock — `RenderService._isPaused` was `false` and `_needsFullRefresh`
`false` on every stale pane, so nothing was suppressing them; they simply had no reason to paint.
A **visible idle** pane is equally exposed. Repair must be pushed, not awaited.

Existing triggers do not cover it. `atlas-correct` events by site over one session:
`heartbeat 62, focus 24, startup 21, fit:resize-observer 12, reattach 3, visibilitychange 1,
fit:init-fonts-ready 1` — and `tryCorrect` is gated on `isActiveRef.current`, so the heartbeat
both **causes** the repack and **skips** the inactive panes it damages. Dispatching a real `focus`
event advanced `plv` 162→163 while `ti3`/`ti4` stayed at `seen=148`. The plan's earlier claim that
the heartbeat bounds repair latency at ~30 s is therefore **refuted for inactive panes**: it is
unbounded, because the pane that needs the frame is the one the trigger excludes. (`dirty: 0`
across the ring also rules out the cell-geometry-drift theory.)

**Fix.** After any atlas mutation, force one frame on **every** live terminal, not just the
mutating one. `correctAtlas()` is the single entry point (P0b), so this is one place. Needs a
registry of live terminals — `terminal-cache.ts` tracks only `SerializeAddon`, so add live
`XTerm` handles (mounted + cached) and iterate `terminal.refresh(0, rows-1)`. Public API only; no
private `_renderer` access, unlike the pre-bump broadcast which would have needed
`_renderer.handleResize`. That is a direct benefit of the bump.

**Cost measured, not estimated:** broadcasting `refresh()` to all 7 panes (six at 185×95, one at
86×100) and awaiting two rAFs = **9.1–14.5 ms** across 5 rounds. At the heartbeat's 30 s cadence
that is negligible, and the version compare makes it a genuine no-op on already-current panes —
`_updateModel(start, end)` with nothing dirty, no atlas work.

**Tests. DONE — written failing-first, now green.** `webgl-loader.test.ts` **22/22** (6 new; 3
failed before the implementation for exactly the missing-broadcast reason, 3 passed as
back-compat guards). `xterm-atlas-fix.test.ts` **4/4** guards the pinned build. Typecheck ✅,
eslint on all 4 changed files ✅ (zero problems), `pnpm build` ✅.

Registry decisions, resolved from the code rather than guessed:
- **Lives in `terminal-cache.ts`** — that module already *is* the live-terminal registry
  (`activeAddons` is the precedent), and every import in it is `import type`, so it stays
  runtime-free and testable under plain tsx. No barrel change needed: the barrel exports only
  `markSkipCache` / `serializeTerminalHistory`; `Terminal.tsx` imports directly.
- **Broadcast unconditionally, not gated on `plv`** — reading `plv` needs private
  `atlas._pageLayoutVersion`. Gating would reach into private state to save a measured no-op.
- Registered at all three lifecycle sites (fresh mount, cached reattach, unmount) and threaded
  into all three `correctAtlas` paths, including the startup window via `loadWebglRenderer`.

**E2E `101-shared-atlas-sibling-repair.spec.ts` — 2/2 PASS** (1.8m, isolated harness, no dev-app
restart). It gates the P0/P0b upstream contract, driving `refresh()` itself, so it is NOT a P0c
broadcast test. Measured:

```
3 WebGL panes, distinctAtlases 1, versionSupported true, lastSeenPerPane [8,8,8]
baseline / after paint / after sibling repack+paint:  128/128  131/131  134/134  (all 1.0000)
active pane unforced self-heal: 28248ms
soak 70000ms: 28 samples, active worst 1.0000, hidden worst 1.0000, dirty 0
stale hidden pane on becoming visible: repaired after 1ms
```

Two findings from that run:
- **28.2 s unforced self-heal** on the active pane — consistent with waiting out one 30 s
  heartbeat, i.e. the bump repairs but slowly when nothing else paints. Exactly P0c's target.
- **1 ms on becoming visible** — a pane the user switches to repairs effectively instantly,
  because the switch itself makes it paint. So the residual user-visible exposure is narrower
  than feared: it is the *already-visible idle* pane, not the tab you switch to.

The spec's own oracle note corrects the one in this plan: compare texcoords **numerically**,
keyed by the same `(code, bg, fg, ext)` the renderer used. Do NOT reverse-map `tile → char` — after
a repack a stale coord can point at a not-yet-allocated tile, which a reverse map scores as
"unknown" and skips, silently grading corruption as a pass. The CDP oracle used earlier in this
investigation had that flaw and therefore under-reported.

### P0 risks (accepted, with mitigations)

| Risk | Mitigation |
|---|---|
| **Repair needs a frame**, and the heartbeat that repacks the atlas skips inactive panes — so an idle pane (hidden *or* visible) can stay scrambled indefinitely. **Measured, not hypothetical:** 52 repacks behind, 0% agreement, across several ticks. | **P0c** — broadcast one `refresh()` to every live terminal after any atlas mutation. Measured cost 9–14 ms for 7 panes; no-op on already-current panes. The bump alone is NOT sufficient. |
| **73 betas of behavioural churn** (219 → 291/292, ~2 months). Typings are clean but typings don't cover behaviour; `WebglRenderer` gained an `ILogService` arg, a dispose `clearTimeout`, a null-row guard, and #6043 changed page capping. | Live verify + the terminal e2e suite. Note `pnpm test:unit` is **not in CI**, so automated coverage here is thin — the live pass is the real gate. |
| **webgl pinned one build behind** and `0.20.0-beta.292` is a 404. | Documented in the `//xterm` comment so it isn't "fixed" into a 404. Peer is `^`-satisfied; today's tree already tolerates a looser peer. |
| **Beta channel ratchet.** No 6.1 stable exists; betas can be unpublished or retagged, so a pinned beta may vanish on a fresh resolve. | Pre-existing (we are already on beta). Lockfile preserves reproducibility. Re-pin to stable when 6.1 ships. |
| **Keeping the heartbeat keeps firing shared-atlas repacks** every 30 s per active pane, now relying on upstream's new versioning to absorb them — higher steady-state exposure to the new code path than removing the trigger. | Deliberate: the heartbeat covers a *different* real cause (silent Metal eviction). Removing it would drop working functionality. |

**Rejected alternative:** `pnpm patch` porting #6042 + #6055 onto beta.219 — surgical, zero churn,
no skew, but we own the patch, it breaks on every future bump, and patch diffs rot silently.
Upstream-maintained beats locally-owned. (Porting only the community #6018 —
`_requestClearModel = true` — is outright **insufficient**: consume-once means exactly one sibling
repairs, broken for N>2 panes, which is why upstream closed it.)

---

## P1 — Two MATERIAL byte-filter defects (both reproduced locally)

Byte stream is **cleared as a scramble suspect**: 2,064,064 bytes / 188,815 ESC bytes across 7
live buffers → 0 malformed; `ESC(0` line-drawing charset **0 occurrences** (only `ESC(B`×48 +
SI×48, both forcing ASCII); DECSET 2026 balanced everywhere (buf6 4786/4786); scramble codepoints
absent from every pty stream. These two are real bugs regardless.

### D1 — Warm-pool handoff drops the stateful stripper's held tail

`createDeviceStatusQueryStripper()` (`device-status-queries.ts:110-130`) holds an incomplete CSI
tail in a closure `carry` with **no flush accessor**. `warm-process-manager.ts:339` owns one per
warm handle; `claimWarmShell` disposes the listener at `:172` and hands `seedBuffer` off — the
carry is silently discarded. The live path that takes over is the **stateless**
`filterBufferData`, so the tail's continuation arrives with nothing to rejoin.

Reproduced:
```
seed  "hello"                     carry held "ESC[2"
ADOPT → dataDisposable.dispose()  carry DROPPED
live  "J ESC[32m rest"
terminal sees "helloJ..."          ← bare J printed, ESC[2 lost
```

**Fix.** Give the stripper a `flush()` that returns and clears `carry`, then append
`stripSeed.flush()` to `seedBuffer` in `claimWarmShell` before handing off. Shape: return a
callable with a `flush` property (keeps all existing call sites source-compatible) — the file's
own comment at `:336` already asserts "nothing is lost", so this restores the documented
invariant rather than changing it.

**Tests (failing first).** `device-status-queries.test.ts`: feed a torn tail, assert `flush()`
returns it and a second `flush()` returns `''`. `warm-process-manager.test.ts` (already
registered, electron+strict): drive a fake pty emitting `'hello\x1b[2'`, adopt, assert the
returned `seedBuffer` ends with the held bytes.

### D2 — Unbounded OSC hold freezes the terminal

`sync-query-response.ts:134`:
```ts
const partial = forwarded.match(/\x1b(?:\][^\x07\x1b]*\x1b?|\[[?<>0-9;:]*)?$/)
```
The **CSI** branch self-bounds — any text byte breaks `[?<>0-9;:]`. The **OSC** branch's
`[^\x07\x1b]*` matches *everything* that isn't BEL or ESC, so once a chunk ends inside an OSC body
the hold grows without limit and **nothing is emitted**. Reproduced:
```
emit ""  held 5 → 15 → 28 → 38 → 51 …   (three plain lines produced zero output)
```
then released in full the instant an ESC arrived. Terminal appears **frozen, not scrambled**.
`device-status-queries.ts` already caps its twin at `MAX_HELD_TAIL = 32`; this site has no cap.

This is the **only** defect that shares the "resize fixes it" signature — SIGWINCH triggers a
redraw whose first ESC releases the hold — which is why it must be recorded as distinct from the
scramble and not conflated with it.

**Fix.** Cap the held OSC tail at **32**, reusing `MAX_HELD_TAIL`. Over the cap → forward verbatim
(the pre-existing behaviour for unrecognised sequences) instead of holding. Every OSC query we
answer is ≤ 12 bytes (`ESC]11;?BEL`, `ESC]4;255;?BEL`, `ESC]52;c;?BEL`), so 32 covers the hold's
entire purpose; a longer body is a title or an OSC 52 clipboard *write*, never a query. Forwarding
past the cap loses nothing — the bytes stay contiguous and the terminal's own parser reassembles
them; the only thing given up is our ability to *answer* a query torn at that point, which cannot
happen under 32. Keep the CSI branch as-is.

**Tests (failing first).** `sync-query-response.test.ts` (27 tests today): assert a plain-text
chunk following an OSC-open chunk is emitted rather than held; assert a body past the cap is
forwarded whole; assert a genuine split `ESC]11;?` + `BEL` across two chunks still gets answered
(the regression the hold exists for).

---

## P2 — Five smaller defects, same sweep (all reproduced)

| # | Site | Defect | Fix |
|---|---|---|---|
| D3 | `strip-underline.ts:41` | `ESC[;4m` → `""`. Implicit SGR reset destroyed (`ESC[0;4m` → `ESC[0m` correctly). Cause: `kept=['']` joins to `''`, hits the falsy branch. | Emit `ESC[${filtered}m` when `kept.length > 0` even if `filtered === ''` → `ESC[m` (bare = reset). `ESC[4m` alone still → `""`. |
| D4 | `strip-underline.ts:20-33` | CMYK mangled: `ESC[38;4;10;20;30;40m` → `ESC[38;10;20;30;40m`. Only selectors `5` and `2` are handled; selector `4` falls through and its first component `4` is eaten as underline. | Handle the full ITU T.416 selector set: `0`/`1` (0 params), `2` RGB (3), `3` CMY (3), `4` CMYK (4), `5` index (1). |
| D5 | `Terminal.tsx:840` | Modified-F3 keystrokes swallowed. xterm encodes them `ESC[1;<mod>R` (`Keyboard.ts:244`) — byte-identical to the `[0-9]+;[0-9]+R` alternative in `CURSOR_STATUS_RESPONSE`. Verified: Shift/Ctrl/Alt+F3 → `""`; plain F3 (`ESC OR`) and F1/F2/F4 unaffected. Unfixable by pattern — a CPR reply at row 1 *is* those bytes. | Stop the response being **generated** instead of filtering it afterwards: `terminal.parser.registerCsiHandler({final:'n'}, () => true)` + `{prefix:'?', final:'n'}`. Returning `true` suppresses xterm's `deviceStatus`/`deviceStatusPrivate` (`InputHandler.ts:243-244`), which are the only producers of these bytes, and the input path has no other CPR source. Then **drop** `stripDeviceStatusResponses` from the `onData` path — keeping it as a backstop means F3 stays broken, i.e. no fix. Guard: feed `ESC[6n` and assert `onData` emits nothing. This *is* the documented invariant — "the server is the sole authority for answering these" — enforced at the source. Keep the OSC strip on that line. |
| D6 | `sync-query-response.ts:118` | Catch-all `\x1b\](\d+);[^\x07\x1b]*\?(?:\x07\|\x1b\\)` fires on **any** OSC body ending in `?`. Verified: title `ESC]0;build ok?BEL` is deleted **and** `ESC]0;BEL` is injected into the program's stdin. | Exclude 0/1/2 (title) from the catch-all — never queries; already stripped by `filterBufferData`. Keep 52 (`OSC 52;c;?` is a real clipboard read; the empty reply is valid). |
| D7 | `terminal/src/server/ring-buffer.ts:38-51` | Eviction can start a replay **mid-escape-sequence** (chunk edges are arbitrary pty read boundaries) and re-asserts only `ESC[0m` — charset and scroll-region state are not restored. | Scan the retained head, drop the partial escape prefix, and prepend a fuller prelude: `ESC[0m` + `ESC(B` (ASCII charset) + `ESC[r` (reset scroll region). **Not** alt-screen — asserting `ESC[?1049l` would desync a fullscreen program from what it believes the screen state is. Document that omission. |

**Tests (failing first).** `filter-buffer-data.test.ts` (already registered, 25+ SGR cases) gains
D3 + D4. New `ring-buffer.test.ts` for D7 (register in `run-all.sh`). D5 needs a jsdom/vitest case
driving a real `Terminal` — or, if that proves heavy, a pure unit test over the extracted handler
registration; decide when writing it, and say which was used.

---

## P3 — ⚠️ SCOPE EXIT: two remote-path (hub↔runner) findings

Neither was in the investigation's scope. Flagging loudly rather than folding in silently.
**Recommend landing P3 as its own change** — different subsystem, different reviewers.

### D8 — First remote pty chunk is dropped every session

Runner `ring-buffer.ts:30` `nextSeq = 0` → the first chunk is assigned seq **0**.
Hub `exec-proxies.ts:233` initialises `lastSeq: 0`, and `:192` drops `if (seq <= entry.lastSeq)`.
Verified: `frame seq 0 → DROPPED; 1 → delivered; 2 → delivered`. The `PtyEntry` comment at `:133`
even says "delivery starts at seq 1" — the runner never agreed.

**Fix.** `lastSeq: -1`. `getBufferSince` already returns `seq > params.seq`, so a `-1` backfill
request correctly includes seq 0. **Trap:** `backfilledAt: -1` is the "never backfilled" sentinel
and would then equal `lastSeq`, making `:164` suppress the very first backfill. Change it to
`backfilledAt: number | null = null`. `exec-proxies.test.ts` (vitest) gets a seq-0 case.

### D9 — Live and backfilled frames are not byte-identical

`handlers/pty.ts:103-110` states the two "are interchangeable by contract" — the hub's demux keeps
whichever copy of a seq lands first. But runner `RingBuffer.append` **mutates** `chunks[0]`,
prepending `ESC[0m` on eviction (`:55`) and truncating an oversized single chunk (`:61-65`). A
backfilled head chunk therefore differs from what was streamed live under the same seq — the
contract breaks at exactly the boundary the demux interleaves.

**Fix.** Delete the resync mutation from the **runner's** buffer and keep chunks immutable. The
runner buffer exists solely for short-range gap backfill; eviction-boundary resync is meaningless
there, and the hub's own RingBuffer already resyncs on the replay path (that's D7's file).
`getCurrentSeq()` has **zero callers** in the runner, confirming the buffer's only job is
`getChunksSince`. For the pathological single-chunk-over-cap case, evict rather than truncate, so
backfill reports an honest gap instead of divergent bytes (live delivery already went out
verbatim and is unaffected).

---

## P4 — Diagnostics gaps (cheap, unblocks future triage)

- **Register two passing-but-never-run suites** in `packages/shared/test-utils/run-all.sh`:
  `terminal/src/client/scramble-detector.test.ts` (verified 18/18 pass) and
  `paint-throttle.test.ts` (10/10). They are currently dead weight.
- **Screenshot evidence is unusable.** `scramble-telemetry` ships `canvas.toDataURL()`, but
  `diagnostics-store.ts:196-198` caps every string at 4096 chars, so a 175–390 KB PNG loses ~99%
  (~11 of 1425 scanlines decode). Every recorded scramble event since `d9a577995` has no proof.
  Fix: write the PNG to `<ROOT>/storage/diagnostics/` and store the **path** in the payload — a
  400 KB data URL does not belong in a JSON column. Raising the cap would just move the problem.
- **Record renderer mode + atlas-sharing count** in the canary payload. The DB already corroborates
  the shared-atlas signature circumstantially (28/28 fires with ≥2 WebGL panes live, all >10 s
  after that pane's own correction — median 93 s — zero at startup, all at fractional dpr
  0.9128709435462952 on ANGLE Metal / M1 Max), but only because it was cross-referenced by hand.

---

## Sequencing

Recommended order, one commit per phase:

| # | Phase | Contents | Restart |
|---|---|---|---|
| 1 | P0 + P0b | xterm bump, single atlas-mutation entry point, downgrade-guard test | ✅ done, verified live |
| 2 | **P0c** | broadcast frame to every sharing pane after an atlas mutation | **1 restart** |
| 3 | P3 | D8, D9 — scope exit, own commit | no |
| 4 | P1 + P2 + P4 | D1–D7, test registration, diagnostics payload | no |

P0/P0b are in the working tree and verified live: a sibling now repairs from a plain frame, which
pre-bump only a resize could do. **P0c is not optional** — without it the repair is armed but never
triggered on the panes that need it, so the user-visible symptom survives the bump. It lands alone,
next, with its own live verification (step 5 above).

P3 after that, not deferred: D8 drops the first chunk of *every* remote pty session — real data
loss for a ~2-line fix.

P3 second, not deferred: D8 drops the first chunk of *every* remote pty session — real data loss
for a ~2-line fix. Cheap enough that deferring costs more than doing it.

⚠️ **P3 caveat:** no runner is attached in this environment, so P3 ships unit-tested but **not
exercised end-to-end**. Deferring it until a remote session is available is defensible — flagging
so the call is yours rather than silently assumed.

Nothing is committed without explicit approval.

---

## Decisions taken (were open questions)

1. **P3 → separate commit, immediately after P0.** Rationale above.
2. **OSC hold cap → 32** (reuse `MAX_HELD_TAIL`), not 512. Over-cap forwards verbatim, so a cap
   costs nothing; 512 would freeze the pane 16× longer while protecting queries that are ≤12 bytes.
3. **D5 → suppress at the source AND drop `stripDeviceStatusResponses` from `onData`.** Keeping it
   as a backstop leaves F3 broken, which is not a fix.
4. **P4 screenshot → write the PNG to `<ROOT>/storage/diagnostics/`, store the path.** Dropping
   capture would remove working functionality; a 400 KB data URL never belonged in a JSON column.
5. **Approve P0 first, verify live, then the rest.** — done; P0/P0b verified, which surfaced P0c.
6. **P0c broadcasts to every live terminal, not just same-atlas owners.** The atlas cache is
   module-private (`CharAtlasCache.ts` exports no reader), so "which terminals share this atlas"
   is not answerable through public API. Broadcasting wider is correct anyway: the version compare
   makes a non-sharing pane a no-op, and the measured whole-fleet cost is 9–14 ms. Filtering would
   mean reaching into private state to save nothing.
7. **Broadcast via `terminal.refresh()`, not `_renderer.handleResize()`.** `refresh()` is public and
   now sufficient because of the bump. `handleResize` was only needed pre-bump and is private.

## Unresolved questions

1. P0c registry: extend `terminal-cache.ts` to track live `XTerm` handles, or new module?
2. Broadcast on every `correctAtlas` call, or only when `plv` actually moved?
3. Ship P0c same commit as P0/P0b, or separate commit?
