/**
 * Regression gate for the shared-texture-atlas scramble (xterm.js #6014).
 *
 * `CharAtlasCache` is module-level, so every terminal with matching
 * font/size/DPR/theme shares ONE `TextureAtlas`. `correctAtlas()` (our startup /
 * resize / heartbeat / reattach correction) calls `clearTextureAtlas()`, which
 * repacks that shared atlas — every glyph is re-rasterized at a new tile. The
 * CALLING renderer rebuilds its vertex data; pre-fix, siblings were never told,
 * so they kept painting pre-repack `a_texpage`/`a_texcoord` against post-repack
 * tiles: garbage glyphs over a correct layout, until a resize.
 *
 * The fix (`@xterm/addon-webgl` ≥ 0.20.0-beta.291, upstream #6042 + #6055)
 * replaces the consume-once `_requestClearModel` flag with a monotonic
 * `TextureAtlas.pageLayoutVersion` plus a per-renderer
 * `GlyphRenderer._lastSeenPageLayoutVersion`. On its next paint, every sharing
 * renderer sees the version mismatch (`beginFrame()` → true) and rebuilds its
 * ENTIRE viewport — however many repacks it slept through.
 *
 * That last part is the contract this spec pins, and it is deliberately
 * "repair on next paint" rather than "never stale": the repair runs inside
 * `beginFrame()`, so it needs a paint to happen. What the fix guarantees is that
 * the paint comes out right. Pre-fix, no number of paints helped — only a resize
 * (`handleResize` → `_clearModel` + full redraw) did, which is exactly the
 * "scrambling disappears as soon as I resize" symptom this chases.
 *
 * Two environment facts make the spec meaningful, both asserted rather than
 * assumed:
 *
 *   - Inactive task tabs hide with `visibility: hidden`, not `display: none`.
 *     `IntersectionObserver` ignores `visibility`, so those panes stay UNPAUSED
 *     (`RenderService._isPaused === false`) and can still paint. A `display:
 *     none` pane would be paused, `refresh()` would be a no-op, and this spec
 *     would prove nothing.
 *   - The oracle compares vertex texture coordinates against the atlas cache
 *     EXACTLY (numeric), keyed by the same `(code, bg, fg, ext)` the renderer
 *     used. It does not reverse-map `tile → char`: after a repack a stale coord
 *     can point at a tile that is not allocated yet, which a reverse map reports
 *     as "unknown" and would silently skip — scoring corruption as a pass.
 *
 * `@slayzone/terminal`'s `xterm-atlas-fix.test.ts` guards the shipped bundle
 * against a version downgrade; this spec asserts the behaviour.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  getMainSessionId,
  openTaskTerminal,
  runCommand,
  waitForBufferContains,
  waitForPtySession
} from '../fixtures/terminal'

/** 2 is the minimum that can expose the bug; 3 also covers the rejected
 *  community patch (#6018), whose consume-once flag repaired exactly one
 *  sibling and left the rest scrambled. */
const TAB_COUNT = 3

/** Fraction of attributable cells that must paint the right tile. A rebuilt pane
 *  scores exactly 1.0. A stale pane measured 0.62–0.70 organically and 0.88–0.90
 *  under the mutation below — never 1.0, and never close to it. Only glyphs whose
 *  tile actually MOVED disagree (repacking a glyph set is deterministic, so many
 *  land back on their old tile), which is why the floor sits just under 1.0
 *  instead of near the observed range: the margin absorbs cells the oracle cannot
 *  attribute, not partial corruption.
 *
 *  Verified non-vacuous by mutation: neutralize the fix on the siblings — replace
 *  `GlyphRenderer._lastSeenPageLayoutVersion` with a getter mirroring
 *  `_atlas.pageLayoutVersion`, so the `!==` in `beginFrame()` can never be true,
 *  which is precisely beta.219 (`clearTexture()` set no flag) — then repack from a
 *  live pane. Siblings fell to 0.877 / 0.904 while the repacking pane held 1.0, so
 *  the assertions below do fail on a pre-fix build. Do NOT mutate by pinning the
 *  field low: a permanent mismatch makes `beginFrame()` return true every frame,
 *  forcing a full rebuild on each paint, and the pane scores a perfect 1.0. */
const MIN_AGREEMENT = 0.98

interface PaneReading {
  sessionId: string
  /** Non-blank viewport cells whose glyph the oracle could attribute. */
  compared: number
  matched: number
  /** Cells whose glyph is absent from the atlas cache — this renderer has not
   *  re-requested it since the repack, so it cannot be painting it correctly. */
  uncached: number
  /** Combined (multi-codepoint) cells, excluded from `compared`. */
  skippedCombined: number
  agreement: number
  samples: Array<{ row: number; col: number; chars: string; reason: string }>
}

interface AtlasState {
  sessions: string[]
  webglPanes: number
  domPanes: number
  distinctAtlases: number
  /** False on a pre-fix build — the invalidation signal does not exist. */
  versionSupported: boolean
  atlasVersion: number | null
  lastSeenPerPane: Array<number | null>
  /** Whether a WebGL context can be created at all in this environment. */
  webglAvailable: boolean
}

/**
 * Oracle installed into the page. One string so every entry point shares the
 * internal accessors; xterm internals are private, so each read is defensive and
 * degrades to "no data" rather than throwing mid-spec. Property names survive
 * minification (only locals are renamed), so this works on the built bundle.
 */
const ORACLE_SOURCE = String.raw`
(() => {
  const W = window;
  // MutableDisposable wraps renderer/glyphRenderer behind a .value property.
  const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

  const INDICES_PER_CELL = 11;      // GlyphRenderer vertex stride
  const MODEL_INDICES_PER_CELL = 4; // RenderModel: code, bg, fg, ext
  const COMBINED_CHAR_BIT_MASK = 0x80000000;

  function allPanes() {
    const links = W.__slayzone_terminalLinks || {};
    const out = [];
    for (const sid of Object.keys(links)) {
      const terminal = links[sid] && links[sid]._terminal;
      if (!terminal || !terminal._core) continue;
      const renderService = terminal._core._renderService;
      const renderer = unwrap(renderService && renderService._renderer);
      if (!renderer) continue;
      out.push({
        sid,
        terminal,
        renderService,
        renderer,
        atlas: renderer._charAtlas,
        glyphRenderer: unwrap(renderer._glyphRenderer),
        model: renderer._model
      });
    }
    return out;
  }

  /** Panes on the WebGL renderer. A DOM-renderer pane holds no atlas. */
  function webglPanes() {
    return allPanes().filter(
      (p) => p.atlas && p.glyphRenderer && p.glyphRenderer._vertices && p.model
    );
  }

  function canCreateWebgl() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  /**
   * Exact per-pane check: for every non-blank viewport cell, look the glyph up in
   * the SHARED atlas cache with the same (code,bg,fg,ext) the renderer used, then
   * compare the vertex data against that glyph's real tile.
   *
   * A cell matches when the vertex page and texcoord.y are exactly the glyph's
   * and texcoord.x lies within the glyph's own width -- _updateCell legitimately
   * shifts x forward when clipping a glyph that overhangs the previous
   * background, so requiring an exact x would false-positive on those cells.
   */
  function readPane(pane) {
    const attrs = pane.glyphRenderer._vertices.attributes;
    const cells = pane.model.cells;
    const cols = pane.terminal.cols;
    const rows = pane.terminal.rows;
    const buf = pane.terminal.buffer.active;
    const cacheMap = pane.atlas._cacheMap;

    let compared = 0;
    let matched = 0;
    let uncached = 0;
    let skippedCombined = 0;
    const samples = [];

    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) continue;
      for (let x = 0; x < cols; x++) {
        const m = (y * cols + x) * MODEL_INDICES_PER_CELL;
        const code = cells[m];
        // Blank / not-yet-modelled cell: nothing painted, nothing to verify.
        if (!code) continue;
        if (code & COMBINED_CHAR_BIT_MASK) {
          skippedCombined++;
          continue;
        }
        const cell = line.getCell(x);
        const chars = cell ? cell.getChars() : '';
        if (!chars || chars === ' ') continue;

        const glyph = cacheMap && cacheMap.get(code, cells[m + 1], cells[m + 2], cells[m + 3]);
        if (!glyph || !glyph.texturePositionClipSpace) {
          // The atlas holds no tile for what this renderer thinks it is painting
          // — only possible if it has not repainted since the repack.
          uncached++;
          compared++;
          if (samples.length < 8) samples.push({ row: y, col: x, chars, reason: 'uncached' });
          continue;
        }

        const v = (y * cols + x) * INDICES_PER_CELL;
        if (v + 6 >= attrs.length) continue;
        compared++;
        const page = attrs[v + 4];
        const tx = attrs[v + 5];
        const ty = attrs[v + 6];
        const gx = glyph.texturePositionClipSpace.x;
        const gy = glyph.texturePositionClipSpace.y;
        const gw = glyph.sizeClipSpace ? glyph.sizeClipSpace.x : 0;
        const ok =
          page === glyph.texturePage &&
          Math.abs(ty - gy) < 1e-9 &&
          tx >= gx - 1e-9 &&
          tx <= gx + gw + 1e-9;
        if (ok) matched++;
        else if (samples.length < 8) {
          samples.push({
            row: y,
            col: x,
            chars,
            reason:
              'painting ' + page + ',' + tx.toFixed(6) + ',' + ty.toFixed(6) +
              ' want ' + glyph.texturePage + ',' + gx.toFixed(6) + ',' + gy.toFixed(6)
          });
        }
      }
    }
    return {
      sessionId: pane.sid,
      compared,
      matched,
      uncached,
      skippedCombined,
      agreement: compared === 0 ? 1 : matched / compared,
      samples
    };
  }

  W.__atlasOracle = {
    state() {
      const all = allPanes();
      const wg = webglPanes();
      const atlases = [];
      for (const p of wg) if (!atlases.includes(p.atlas)) atlases.push(p.atlas);
      const first = atlases[0];
      const supported = !!first && 'pageLayoutVersion' in first;
      return {
        sessions: wg.map((p) => p.sid),
        webglPanes: wg.length,
        domPanes: all.length - wg.length,
        distinctAtlases: atlases.length,
        versionSupported: supported,
        atlasVersion: supported ? first.pageLayoutVersion : null,
        lastSeenPerPane: wg.map((p) =>
          '_lastSeenPageLayoutVersion' in p.glyphRenderer
            ? p.glyphRenderer._lastSeenPageLayoutVersion
            : null
        ),
        webglAvailable: canCreateWebgl()
      };
    },

    /** Per-pane paused flag. A paused pane cannot paint, so it is neither
     *  corruptible nor repairable and would make the spec vacuous. */
    paused() {
      return webglPanes().map((p) => ({ sid: p.sid, isPaused: !!p.renderService._isPaused }));
    },

    read() {
      return webglPanes().map(readPane);
    },

    /** Repack the shared atlas from ONE pane — what correctAtlas() does. */
    repack(sid) {
      const p = webglPanes().find((q) => q.sid === sid);
      if (!p) return null;
      p.renderer.clearTextureAtlas();
      return p.sid;
    },

    /** Force a paint. Omit sid to paint every pane; pass one to skip it. */
    paint(exceptSid) {
      const touched = [];
      for (const p of webglPanes()) {
        if (exceptSid && p.sid === exceptSid) continue;
        p.terminal.refresh(0, p.terminal.rows - 1);
        touched.push(p.sid);
      }
      return touched;
    }
  };
  return W.__atlasOracle.state();
})()
`

/** Let queued rAF render work land (RenderService debounces through rAF). */
async function frames(page: import('@playwright/test').Page, count = 4): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n
        const tick = (): void => {
          if (--left <= 0) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    count
  )
}

const fmt = (rs: PaneReading[]): string =>
  rs
    .map(
      (r) =>
        `${r.sessionId.slice(0, 8)} ${r.matched}/${r.compared}` +
        (r.uncached ? ` (uncached ${r.uncached})` : '')
    )
    .join('  ')

test.describe('shared texture atlas — siblings repair after a repack', () => {
  let projectAbbrev: string
  const taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Shared Atlas',
      color: '#f472b6',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    for (let i = 0; i < TAB_COUNT; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: `Shared atlas ${i + 1}`,
        status: 'in_progress'
      })
      await mainWindow.evaluate(
        (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
        t.id
      )
      taskIds.push(t.id)
    }
    await s.refreshData()
  })

  test('every sibling rebuilds its viewport after a shared-atlas repack', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)

    // Open each tab and print distinctive text. Different text per pane matters:
    // each renderer then needs glyphs the others do not, so a stale sibling
    // cannot accidentally agree by sharing the repacking pane's tiles.
    for (let i = 0; i < TAB_COUNT; i++) {
      await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: `Shared atlas ${i + 1}` })
      const sid = getMainSessionId(taskIds[i])
      await waitForPtySession(mainWindow, sid)
      const marker = `atlas${'X'.repeat(i + 1)}-pane${i + 1}-${'abcdefghijklmnopqrstuvwxyz'.slice(i, i + 12)}${i}${i}${i}`
      await runCommand(mainWindow, sid, `echo ${marker}`)
      await waitForBufferContains(mainWindow, sid, marker)
    }
    // Startup corrections run at +0/250/750ms after each load; let the last
    // pane's window close so the atlas is settled, not mid-correction.
    await mainWindow.waitForTimeout(1_500)
    await frames(mainWindow)

    // The last-opened tab is the active one; the rest are hidden but unpaused.
    const activeSid = getMainSessionId(taskIds[TAB_COUNT - 1])

    const state: AtlasState = await mainWindow.evaluate(ORACLE_SOURCE)
    console.log('[atlas] state:', JSON.stringify(state))

    // Only a GPU-less environment legitimately has no siblings. Anything else (a
    // downgrade, a lost context) must fail loudly — skipping there would turn a
    // broken renderer into a green suite.
    test.skip(
      !state.webglAvailable,
      'no WebGL context available in this environment — the shared atlas cannot exist'
    )
    expect(
      state.webglPanes,
      `need ≥2 WebGL panes to have a sibling to corrupt (webgl=${state.webglPanes} ` +
        `dom=${state.domPanes}); WebGL IS available here, so a shortfall means panes were downgraded`
    ).toBeGreaterThanOrEqual(2)

    // The precondition the entire bug rests on.
    expect(state.distinctAtlases, 'WebGL panes share exactly ONE texture atlas').toBe(1)
    // The invalidation signal must exist on the shipped bundle.
    expect(state.versionSupported, 'atlas exposes pageLayoutVersion (post-fix build)').toBe(true)

    // Hidden tabs must still be paintable, or nothing below means anything.
    const paused = (await mainWindow.evaluate('(() => window.__atlasOracle.paused())()')) as Array<{
      sid: string
      isPaused: boolean
    }>
    expect(
      paused.filter((p) => !p.isPaused).length,
      'at least 2 WebGL panes unpaused (hidden tabs use visibility:hidden, so they keep painting)'
    ).toBeGreaterThanOrEqual(2)

    // Opening tabs sequentially already exercises the bug: each new pane's
    // startup correction repacks the SHARED atlas, so earlier panes are behind by
    // however many repacks happened after their last paint. Recorded, not
    // asserted — how far behind depends on real paint timing. The assertion is
    // that ONE paint clears the whole backlog.
    const backlog = state.lastSeenPerPane.filter((v) => v !== state.atlasVersion).length
    const baseline = (await mainWindow.evaluate(
      '(() => window.__atlasOracle.read())()'
    )) as PaneReading[]
    console.log(
      `[atlas] baseline (atlas v${state.atlasVersion}, renderers ${JSON.stringify(
        state.lastSeenPerPane
      )}, ${backlog} behind): ${fmt(baseline)}`
    )
    // Guard against a vacuous pass: the oracle must be attributing real cells.
    expect(
      Math.min(...baseline.map((r) => r.compared)),
      'every pane offered cells to compare'
    ).toBeGreaterThan(20)

    // --- Contract 1: one paint clears any repack backlog, on every pane. ---
    await mainWindow.evaluate('(() => window.__atlasOracle.paint())()')
    await frames(mainWindow)
    const settled = (await mainWindow.evaluate(
      '(() => window.__atlasOracle.read())()'
    )) as PaneReading[]
    console.log('[atlas] after one paint on every pane:', fmt(settled))
    for (const r of settled) {
      if (r.agreement <= MIN_AGREEMENT) {
        console.log(`[atlas] STALE ${r.sessionId.slice(0, 8)}`, JSON.stringify(r.samples))
      }
    }
    for (const r of settled) {
      expect(
        r.agreement,
        `pane ${r.sessionId.slice(0, 8)} rebuilt its viewport on one paint after ` +
          `${backlog} pane(s) were behind the shared atlas (uncached=${r.uncached})`
      ).toBeGreaterThan(MIN_AGREEMENT)
    }

    // --- Contract 2: a repack by ONE pane does not corrupt the others. ---
    const versionBefore: number | null = (
      (await mainWindow.evaluate('(() => window.__atlasOracle.state())()')) as AtlasState
    ).atlasVersion
    const repacked = (await mainWindow.evaluate(
      (sid) =>
        (window as unknown as { __atlasOracle: { repack: (s: string) => string | null } })
          .__atlasOracle.repack(sid),
      activeSid
    )) as string | null
    expect(repacked, 'repacked from the active pane').toBe(activeSid)

    const bumped: AtlasState = await mainWindow.evaluate('(() => window.__atlasOracle.state())()')
    expect(
      bumped.atlasVersion,
      'clearTextureAtlas bumped pageLayoutVersion — the signal siblings key off'
    ).toBeGreaterThan(versionBefore ?? -1)

    const touched = (await mainWindow.evaluate(
      (sid) =>
        (window as unknown as { __atlasOracle: { paint: (s: string) => string[] } }).__atlasOracle
          .paint(sid),
      activeSid
    )) as string[]
    expect(touched.length, 'at least one sibling forced to repaint').toBeGreaterThan(0)
    await frames(mainWindow)

    const after = (await mainWindow.evaluate(
      '(() => window.__atlasOracle.read())()'
    )) as PaneReading[]
    console.log('[atlas] after sibling repack + forced paint:', fmt(after))
    for (const r of after) {
      if (r.agreement <= MIN_AGREEMENT) {
        console.log(`[atlas] STALE ${r.sessionId.slice(0, 8)}`, JSON.stringify(r.samples))
      }
    }
    for (const r of after) {
      expect(
        r.agreement,
        `pane ${r.sessionId.slice(0, 8)} repaired after a SIBLING repacked the shared ` +
          `atlas (uncached=${r.uncached})`
      ).toBeGreaterThan(MIN_AGREEMENT)
    }

    // The mechanism, not just the outcome: every renderer caught up to the atlas.
    const caught: AtlasState = await mainWindow.evaluate('(() => window.__atlasOracle.state())()')
    for (const seen of caught.lastSeenPerPane) {
      expect(seen, 'each renderer tracked the atlas page-layout version').toBe(caught.atlasVersion)
    }

    // --- Contract 3: the ACTIVE pane recovers with no forced paint. ---
    // Repair runs inside beginFrame(), so it needs a paint. For the pane the user
    // is looking at, cursor blink and our own 30s heartbeat (correctAtlas →
    // refresh) both supply one. Measured, not assumed: an unforced repack from a
    // BACKGROUND pane is the real-world trigger (its heartbeat/reattach fires
    // while the user is on another tab).
    const backgroundSid = state.sessions.find((s) => s !== activeSid)
    expect(backgroundSid, 'found a background pane to repack from').toBeTruthy()
    await mainWindow.evaluate(
      (sid) =>
        (window as unknown as { __atlasOracle: { repack: (s: string) => string | null } })
          .__atlasOracle.repack(sid),
      backgroundSid as string
    )

    const startedAt = Date.now()
    let healedAfterMs: number | null = null
    let worst = 1
    // Poll past one 30s heartbeat tick so a miss is measured, not truncated.
    while (Date.now() - startedAt < 45_000) {
      const readings = (await mainWindow.evaluate(
        '(() => window.__atlasOracle.read())()'
      )) as PaneReading[]
      const activeReading = readings.find((r) => r.sessionId === activeSid)
      worst = activeReading ? activeReading.agreement : 1
      if (worst > MIN_AGREEMENT) {
        healedAfterMs = Date.now() - startedAt
        break
      }
      await mainWindow.waitForTimeout(500)
    }
    console.log(
      `[atlas] active pane unforced self-heal: ${
        healedAfterMs === null
          ? `NOT healed within 45s (agreement ${worst.toFixed(4)})`
          : `${healedAfterMs}ms`
      }`
    )
    expect(
      healedAfterMs,
      `active pane self-heals with no resize and no forced paint (agreement ${worst.toFixed(4)})`
    ).not.toBeNull()
  })

  /**
   * The steady state, driven by the app's own timers instead of the oracle, and
   * then the moment that actually reaches the user: switching TO a tab that went
   * stale while hidden.
   *
   * Setup is the real-world trigger, not a synthetic one. The heartbeat
   * (`Terminal.tsx` → `setInterval(tryCorrect('heartbeat'), 30_000)`) is gated on
   * `isActive`, so over a 70s idle window the ACTIVE pane repacks the shared atlas
   * twice while the hidden panes are never told to correct themselves.
   *
   * A hidden pane then has no paint source at all: no output arrives, cursor blink
   * only runs on the focused terminal, and its own heartbeat is gated off. Since
   * the repair executes inside `beginFrame()`, no paint means no repair — measured
   * here as a hidden pane sitting at 0.625 agreement across all 28 samples of the
   * soak, never self-healing. That is EXPECTED and is not the bug: nothing is on
   * screen, so nothing is visibly wrong, and `WebglRenderer.renderRows` promotes
   * any subsequent paint to `_updateModel(0, rows - 1)` — a full-viewport rebuild
   * regardless of the range asked for.
   *
   * The contract that matters, and what this test asserts, is the handoff: by the
   * time a stale pane becomes visible it must be repaired. Note that
   * `ensureFit('reactivate')` cannot be what guarantees it — it early-returns when
   * the proposed geometry matches, which is the common case for a tab switch that
   * changed no widths, so no fit and no `scheduleAtlasCorrection` happen. The
   * repair therefore has to come from the visibility flip's own repaint.
   */
  test('a pane that went stale while hidden is repaired by the time it is visible', async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)

    const state: AtlasState = await mainWindow.evaluate(ORACLE_SOURCE)
    test.skip(!state.webglAvailable, 'no WebGL context available in this environment')
    expect(state.webglPanes, 'panes from the previous test still mounted').toBeGreaterThanOrEqual(2)

    await mainWindow.evaluate(
      '(() => window.__slayzone_terminalDiag && window.__slayzone_terminalDiag.clear())()'
    )

    // --- Idle soak: let the active pane's heartbeat repack the shared atlas. ---
    const SOAK_MS = 70_000 // > 2 × 30s heartbeat, with margin for the rAF debounce
    const activeSid = getMainSessionId(taskIds[TAB_COUNT - 1])
    const samples: Array<{ atMs: number; active: number; worstHidden: number }> = []
    const startedAt = Date.now()
    while (Date.now() - startedAt < SOAK_MS) {
      await mainWindow.waitForTimeout(2_500)
      const rs = (await mainWindow.evaluate(
        '(() => window.__atlasOracle.read())()'
      )) as PaneReading[]
      const active = rs.find((r) => r.sessionId === activeSid)
      const hidden = rs.filter((r) => r.sessionId !== activeSid)
      samples.push({
        atMs: Date.now() - startedAt,
        active: active ? active.agreement : 1,
        worstHidden: hidden.length ? Math.min(...hidden.map((r) => r.agreement)) : 1
      })
    }

    // A soak that saw no heartbeat repack proves nothing — the timer must have
    // fired and actually repacked the shared atlas during the window.
    const corrections = (await mainWindow.evaluate(`
      (() => {
        const d = window.__slayzone_terminalDiag;
        if (!d) return null;
        const evts = d.dump().filter((e) => e.event === 'atlas-correct');
        const bySite = {};
        for (const e of evts) bySite[e.site || 'none'] = (bySite[e.site || 'none'] || 0) + 1;
        return { total: evts.length, bySite, dirty: d.dirty().length };
      })()
    `)) as { total: number; bySite: Record<string, number>; dirty: number } | null
    const worstActive = Math.min(...samples.map((s) => s.active))
    const worstHidden = Math.min(...samples.map((s) => s.worstHidden))
    console.log(
      `[atlas] soak ${SOAK_MS}ms: ${samples.length} samples, active worst ` +
        `${worstActive.toFixed(4)}, hidden worst ${worstHidden.toFixed(4)}, ` +
        `corrections ${JSON.stringify(corrections)}`
    )

    expect(corrections, 'diag ring available').not.toBeNull()
    expect(
      corrections?.bySite.heartbeat ?? 0,
      'the 30s heartbeat repacked the shared atlas at least twice during the soak — ' +
        'without that, the soak asserts nothing'
    ).toBeGreaterThanOrEqual(2)

    // The pane the user is looking at must never drift, at any sample: its own
    // heartbeat repacks the atlas and its next paint has to come out right.
    for (const s of samples) {
      expect(
        s.active,
        `the ACTIVE pane held agreement at ${s.atMs}ms of an idle soak spanning ` +
          `${corrections?.bySite.heartbeat} heartbeat repacks`
      ).toBeGreaterThan(MIN_AGREEMENT)
    }
    // Geometry-drift signal, independent of the oracle.
    expect(corrections?.dirty, 'no dirty-atlas (cell geometry moved without a correction)').toBe(0)

    // --- The handoff: switch to whichever hidden pane is furthest behind. ---
    const preSwitch = (await mainWindow.evaluate(
      '(() => window.__atlasOracle.read())()'
    )) as PaneReading[]
    const stalest = preSwitch
      .filter((r) => r.sessionId !== activeSid)
      .reduce((a, b) => (b.agreement < a.agreement ? b : a))
    console.log(
      `[atlas] stalest hidden pane before switch: ${stalest.sessionId.slice(0, 8)} ` +
        `${stalest.matched}/${stalest.compared} (${stalest.agreement.toFixed(4)})`
    )

    const stalestIndex = taskIds.findIndex((id) => getMainSessionId(id) === stalest.sessionId)
    expect(stalestIndex, 'resolved the stale pane back to its task').toBeGreaterThanOrEqual(0)

    // Real user action — click through to the tab, no oracle involvement.
    await openTaskTerminal(mainWindow, {
      projectAbbrev,
      taskTitle: `Shared atlas ${stalestIndex + 1}`
    })
    await frames(mainWindow)

    // Give the visibility flip's repaint a moment to land, then assert. Polled
    // rather than one-shot so a slow frame is not read as corruption, but the
    // window is short: this is the interval during which the user could SEE
    // scrambled glyphs, so it must close fast.
    const VISIBLE_DEADLINE_MS = 3_000
    const switchedAt = Date.now()
    let repairedAfterMs: number | null = null
    let latest = stalest.agreement
    while (Date.now() - switchedAt < VISIBLE_DEADLINE_MS) {
      const rs = (await mainWindow.evaluate(
        '(() => window.__atlasOracle.read())()'
      )) as PaneReading[]
      const now = rs.find((r) => r.sessionId === stalest.sessionId)
      latest = now ? now.agreement : 1
      if (latest > MIN_AGREEMENT) {
        repairedAfterMs = Date.now() - switchedAt
        break
      }
      if (now) console.log('[atlas] still stale:', JSON.stringify(now.samples))
      await mainWindow.waitForTimeout(250)
    }
    console.log(
      `[atlas] stale pane on becoming visible: ${
        repairedAfterMs === null
          ? `NOT repaired within ${VISIBLE_DEADLINE_MS}ms (agreement ${latest.toFixed(4)})`
          : `repaired after ${repairedAfterMs}ms`
      }`
    )
    expect(
      repairedAfterMs,
      `a pane that fell to ${stalest.agreement.toFixed(4)} while hidden must be repaired ` +
        `by the time the user sees it — otherwise this is the reported scramble, visible ` +
        `until a resize (agreement ${latest.toFixed(4)})`
    ).not.toBeNull()
  })
})
