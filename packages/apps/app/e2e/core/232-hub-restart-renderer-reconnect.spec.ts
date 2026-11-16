/**
 * After the local hub restarts (Settings → Restart local hub, or the supervisor
 * respawning a crashed sidecar), the window's tRPC client is answering again within
 * seconds — every time — and keeps answering.
 *
 * It used to sit "Hub unreachable — … did not connect within 15000ms (Initialization
 * error)" for 75s+ in some runs although the hub was up: one socket stuck in its
 * opening handshake parked every call (transport connectHandshake.ts). And right
 * after a call had reconnected, the client's own reconnect timer closed that healthy
 * socket, failing whatever was in flight ("WebSocket closed"; patched @trpc/client).
 *
 * `restartSidecar()` resolves once the supervisor has seen the new hub healthy; from
 * there each run times the first successful call, then keeps calling for 4s (past the
 * reconnect loop's next timer) and requires every one of those calls to succeed. On
 * failure the window's connect trace (every attempt: probe answers, sockets, outcomes)
 * is attached.
 */
import { test, expect } from '../fixtures/electron'

/** Target ~3s on a quiet box; the margin is for a saturated one. */
const FIRST_CALL_BUDGET_MS = 5_000
const RUNS = 8

type RunResult = {
  restart: { ok: boolean; error?: string }
  firstOkMs: number | null
  lastError: string | null
  /** Calls issued after the first success that failed. */
  errorsAfterOk: string[]
}

test.describe('Renderer tRPC client across hub restarts', () => {
  test(`answers within ${FIRST_CALL_BUDGET_MS}ms after each of ${RUNS} restarts, and keeps answering`, async ({
    mainWindow
  }, testInfo) => {
    test.setTimeout(RUNS * 45_000)
    const results: RunResult[] = []
    for (let i = 0; i < RUNS; i++) {
      const result = await mainWindow.evaluate(
        async ({ budgetMs }): Promise<RunResult> => {
          const w = window as unknown as {
            api: { app: { restartSidecar: () => Promise<{ ok: boolean; error?: string }> } }
            getTrpcVanillaClient: () => {
              settings: { get: { query: (i: { key: string }) => Promise<unknown> } }
            }
          }
          const restart = await w.api.app.restartSidecar()
          const readyAt = Date.now()
          const call = () =>
            w.getTrpcVanillaClient().settings.get.query({ key: 'terminal_agent_startup' })
          let firstOkMs: number | null = null
          let lastError: string | null = null
          const errorsAfterOk: string[] = []
          const inFlight: Promise<unknown>[] = []
          // A call every 100ms, as the app itself keeps issuing them.
          while (Date.now() - readyAt < budgetMs + 15_000) {
            const issuedAt = Date.now()
            const afterOk = firstOkMs !== null
            inFlight.push(
              call().then(
                () => {
                  if (firstOkMs === null) firstOkMs = Date.now() - readyAt
                },
                (e: unknown) => {
                  const msg = e instanceof Error ? e.message : String(e)
                  lastError = msg
                  if (afterOk) errorsAfterOk.push(`+${issuedAt - readyAt}ms: ${msg}`)
                }
              )
            )
            await new Promise((r) => setTimeout(r, 100))
            if (firstOkMs !== null && Date.now() - readyAt > firstOkMs + 4_000) break
          }
          await Promise.allSettled(inFlight)
          return { restart, firstOkMs, lastError, errorsAfterOk }
        },
        { budgetMs: FIRST_CALL_BUDGET_MS }
      )
      results.push(result)
      const failed =
        !result.restart.ok ||
        result.firstOkMs === null ||
        result.firstOkMs > FIRST_CALL_BUDGET_MS ||
        result.errorsAfterOk.length > 0
      if (failed) {
        const traces = await mainWindow.evaluate(() => {
          const w = window as unknown as { __slayzone_hubConnectTraces?: () => unknown }
          return w.__slayzone_hubConnectTraces?.() ?? 'no trace hook in this build'
        })
        await testInfo.attach(`run-${i}-connect-trace.json`, {
          body: JSON.stringify({ result, traces }, null, 2),
          contentType: 'application/json'
        })
      }
    }
    await testInfo.attach('runs.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json'
    })
    console.log(
      `[232] first call after restart (ms): ${results.map((r) => r.firstOkMs ?? 'never').join(', ')}`
    )
    for (const [i, r] of results.entries()) {
      expect(r.restart, `run ${i}: restartSidecar`).toEqual({ ok: true })
      expect(
        r.firstOkMs,
        `run ${i}: first successful call (last error: ${r.lastError})`
      ).not.toBeNull()
      expect(r.firstOkMs!, `run ${i}: first successful call`).toBeLessThanOrEqual(
        FIRST_CALL_BUDGET_MS
      )
      expect(r.errorsAfterOk, `run ${i}: calls after the first success`).toEqual([])
    }
  })
})
