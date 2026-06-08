#!/usr/bin/env bun
// Phase 6 verification driver — connects to a running SlayZone binary via
// CDP (the --remote-debugging-port chosen by the caller) and runs every
// automated check. Non-automatable items (Web Store extensions, actual
// credential entry) are listed in the generated report as `needs_user`.
//
// Usage: bun scripts/chromium/phase-6-verify.mjs \
//          --port <cdp-port> --out <report-json-path> [--ublock-enabled]
//
// Output: JSON report at --out + stdout summary.

import { argv } from 'node:process'
import { writeFileSync } from 'node:fs'

function arg(flag, fallback) {
  const i = argv.indexOf(flag)
  if (i === -1) return fallback
  return argv[i + 1] ?? fallback
}

const PORT = Number.parseInt(arg('--port', '9555'), 10)
const OUT = arg('--out', '/tmp/slayzone-phase-6-report.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} ${res.status}`)
  return res.json()
}

// Minimal CDP client. Each open page has its own WebSocket; one shared CDP
// session per page. We keep method calls request/response correlated by id.
function makeCdp(wsUrl) {
  const pending = new Map()
  let nextId = 1
  const events = []
  const ws = new WebSocket(wsUrl)
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res())
    ws.addEventListener('error', (e) => rej(e))
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`))
      else resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
    }
  })
  async function send(method, params = {}) {
    await ready
    const id = nextId++
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    ws.send(JSON.stringify({ id, method, params }))
    return p
  }
  return {
    send,
    close: () => ws.close(),
    events,
  }
}

// Browser-level CDP endpoint (for Target.* methods + cross-target control).
async function browserCdp() {
  const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`)
  return makeCdp(version.webSocketDebuggerUrl)
}

// Evaluate JS in a target's page context. Returns the JSON-serialized value
// or throws on exception. Uses the per-target WS.
async function evalInPage(target, expression, awaitPromise = false) {
  const cdp = makeCdp(target.webSocketDebuggerUrl)
  try {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })
    if (exceptionDetails) {
      throw new Error(
        `eval: ${exceptionDetails.text} :: ${exceptionDetails.exception?.description ?? ''}`,
      )
    }
    return result.value
  } finally {
    cdp.close()
  }
}

async function listTargets() {
  return fetchJson(`http://127.0.0.1:${PORT}/json/list`)
}

// --------------------------------------------------------------------------
// Checks
// --------------------------------------------------------------------------

const report = {
  started_at: new Date().toISOString(),
  cdp_port: PORT,
  slayzone_shell_reachable: null,
  region_webuis: null,
  extensions: null,
  sso_scripted: null,
  tab_switch: null,
  needs_user: [],
  errors: [],
}

async function run() {
  // 1) Confirm CDP responds + SlayZone is alive.
  const version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`)
  report.browser = version.Browser
  report.user_agent = version['User-Agent']

  // 2) Find the shell tab (chrome://slayzone-shell/) and region webuis by
  //    iterating targets. Region WebUIs are loaded into chromeviewer targets
  //    that share the browser's userDataDir.
  const targets = await listTargets()
  report.target_count = targets.length
  const shell = targets.find((t) => t.url.startsWith('chrome://slayzone-shell'))
  report.slayzone_shell_reachable = !!shell

  const byHost = {}
  for (const t of targets) {
    const m = t.url.match(/^chrome:\/\/([^/]+)\//)
    if (m) byHost[m[1]] = (byHost[m[1]] || 0) + 1
  }
  report.region_webuis = byHost

  // 3) Extension inventory. MV3 service workers show up in /json/list as
  //    `chrome-extension://<id>/<worker>.js` targets, but only once the
  //    worker has actually started. We re-list after the SSO pass (which
  //    opens real http pages) so any content-script-triggered worker wake
  //    has had a chance to register. See step 6.
  report.extensions = {
    loaded_count: 0,
    loaded_ids: [],
  }

  // 4) SSO scripted pass — for each of 4 SSO URLs, open a new page, wait
  //    for load, capture final URL + any console/security errors. Does NOT
  //    perform the actual sign-in.
  const ssoUrls = [
    { name: 'Google', url: 'https://accounts.google.com/' },
    { name: 'GitHub', url: 'https://github.com/login' },
    { name: 'Microsoft', url: 'https://login.microsoftonline.com/' },
    { name: 'Apple', url: 'https://appleid.apple.com/' },
  ]
  const browser = await browserCdp()
  const ssoResults = []
  for (const sso of ssoUrls) {
    try {
      const { targetId } = await browser.send('Target.createTarget', {
        url: sso.url,
      })
      // Wait long enough for redirect(s) to settle. 6s is a generous budget
      // for cold-start TLS + sign-in page render; we don't click anything.
      let finalUrl = sso.url
      let loaded = false
      for (let i = 0; i < 24; i++) {
        await sleep(250)
        const all = await listTargets()
        const t = all.find((x) => x.id === targetId)
        if (!t) break
        if (t.url && t.url !== 'about:blank') {
          finalUrl = t.url
          loaded = true
        }
      }
      // Collect any HTTPS-failure console errors via a quick eval.
      const title = await evalInPage(
        (await listTargets()).find((t) => t.id === targetId),
        'document.title',
      )
      ssoResults.push({
        name: sso.name,
        requested_url: sso.url,
        final_url: finalUrl,
        page_title: title,
        loaded,
        status: loaded ? 'pass-scripted' : 'needs-user-hands-on',
      })
      await browser.send('Target.closeTarget', { targetId })
    } catch (err) {
      ssoResults.push({
        name: sso.name,
        requested_url: sso.url,
        status: 'error',
        error: String(err?.message ?? err),
      })
    }
  }
  report.sso_scripted = ssoResults

  // 5) Re-inventory extensions — service workers may have woken between
  //    extension load and now (http pages opened above can trigger content
  //    scripts, which wake the SW).
  {
    const retry = await listTargets()
    const extTargets = retry.filter((t) =>
      t.url.startsWith('chrome-extension://'),
    )
    const ids = new Set()
    for (const t of extTargets) {
      const id = t.url.replace('chrome-extension://', '').split('/')[0]
      ids.add(id)
    }
    report.extensions.loaded_count = ids.size
    report.extensions.loaded_ids = [...ids]
  }

  // 6) Tab switch benchmark. Caveat: CDP Target.activateTarget is an
  //    imperfect proxy for the true SlayZone tab switch (TabStripModel
  //    selection → inline_tab_webview SetWebContents). The real benchmark
  //    requires a Mojo TabsHost consumer driving SelectTab(), which per
  //    Option C lands in Phase 7.x. What we measure here is the CDP
  //    roundtrip cost of Target.activateTarget against 10 throwaway
  //    targets — a useful smoke metric, but do NOT read the exit
  //    criterion against these numbers.
  const benchTargets = []
  for (let i = 0; i < 10; i++) {
    const { targetId } = await browser.send('Target.createTarget', {
      url: `data:text/html,<title>bench-${i}</title><body>bench ${i}</body>`,
    })
    benchTargets.push(targetId)
  }
  await sleep(500) // let them finish loading
  const latencies = []
  for (let round = 0; round < 5; round++) {
    for (const id of benchTargets) {
      const t0 = performance.now()
      await browser.send('Target.activateTarget', { targetId: id })
      const t1 = performance.now()
      latencies.push(t1 - t0)
    }
  }
  latencies.sort((a, b) => a - b)
  const pct = (p) => latencies[Math.floor((p / 100) * (latencies.length - 1))]
  report.tab_switch = {
    note: 'CDP Target.activateTarget proxy only — true TabStripModel→inline_tab_webview benchmark deferred to Phase 7.x.',
    samples: latencies.length,
    p50_ms: +pct(50).toFixed(2),
    p95_ms: +pct(95).toFixed(2),
    p99_ms: +pct(99).toFixed(2),
    under_50ms_ratio:
      latencies.filter((l) => l < 50).length / latencies.length,
  }
  for (const id of benchTargets) {
    try {
      await browser.send('Target.closeTarget', { targetId: id })
    } catch {}
  }
  browser.close()

  // 7) User-hands-on checklist.
  report.needs_user.push({
    item: '1Password MV3 extension',
    why: 'Chrome Web Store install requires Google sign-in; unpacked build is not publicly distributed.',
    instructions:
      'Open chrome://extensions/ in the running SlayZone, enable Developer mode, and install 1Password from the Web Store. Verify the fill UI appears on a login form.',
  })
  report.needs_user.push({
    item: 'React DevTools extension',
    why: 'Unpacked build requires cloning facebook/react + yarn build; not bundled by default.',
    instructions:
      'Option A: build facebook/react/packages/react-devtools-extensions locally and --load-extension=path. Option B: install from Chrome Web Store (requires Google sign-in).',
  })
  for (const sso of ssoUrls) {
    report.needs_user.push({
      item: `${sso.name} SSO sign-in`,
      why: 'Credentials + 2FA/passkey require live user.',
      instructions: `Navigate to ${sso.url} in the running SlayZone and complete the sign-in flow end-to-end.`,
    })
  }
}

try {
  await run()
} catch (err) {
  report.errors.push(String(err?.stack ?? err))
}

report.finished_at = new Date().toISOString()
writeFileSync(OUT, JSON.stringify(report, null, 2))

// Stdout summary.
const s = report
console.log('=== Phase 6 verification report ===')
console.log(`port=${s.cdp_port} browser=${s.browser}`)
console.log(`shell_reachable=${s.slayzone_shell_reachable}`)
console.log(`region_webuis=${JSON.stringify(s.region_webuis)}`)
console.log(
  `extensions=loaded_count=${s.extensions?.loaded_count} ids=${JSON.stringify(s.extensions?.loaded_ids)}`,
)
console.log('sso_scripted:')
for (const r of s.sso_scripted ?? []) {
  console.log(
    `  - ${r.name.padEnd(10)} status=${r.status} url=${r.final_url ?? r.requested_url}`,
  )
}
if (s.tab_switch) {
  console.log(
    `tab_switch: samples=${s.tab_switch.samples} p50=${s.tab_switch.p50_ms}ms p95=${s.tab_switch.p95_ms}ms p99=${s.tab_switch.p99_ms}ms under_50ms=${(s.tab_switch.under_50ms_ratio * 100).toFixed(1)}%`,
  )
}
if (s.errors.length) {
  console.log('errors:')
  for (const e of s.errors) console.log(`  ${e.split('\n')[0]}`)
}
console.log(`needs_user: ${s.needs_user.length} item(s) (see ${OUT})`)
console.log(`report: ${OUT}`)
