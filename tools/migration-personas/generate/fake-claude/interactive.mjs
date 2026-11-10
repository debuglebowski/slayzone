// What a real interactive (terminal) `claude` leaves behind that SlayZone relies on,
// for the fake's interactive spawns:
//  1. its session file `<CLAUDE_CONFIG_DIR>/projects/<cwd, non-alnum → '-'>/<id>.jsonl`
//     with one user prompt (a fresh start; a resume keeps the file as it is), and
//  2. its hooks (SessionStart; on a fresh start also UserPromptSubmit + Stop): every
//     command under `hooks.<event>` in
//     `<CLAUDE_CONFIG_DIR>/settings.json` (SlayZone's notify.sh) gets the payload on
//     stdin, with the spawn's env (SLAYZONE_AGENT_HOOK_URL / _CONTEXT) inherited.
// usage: node interactive.mjs <session id> <startup|resume>
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [sessionId, source] = process.argv.slice(2)
if (!sessionId) process.exit(0)
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude')
const cwd = process.cwd()
const file = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
if (!fs.existsSync(file)) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const at = new Date().toISOString()
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'user', sessionId, cwd, uuid: randomUUID(), parentUuid: null, timestamp: at, message: { role: 'user', content: 'hello' } })}\n`
  )
}
let settings = {}
try {
  settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'))
} catch {}
// The hooks a real session fires: it starts, and on a fresh start the user types a
// prompt and the turn ends (what makes the session the tab's current one).
function fire(event, extra) {
  const payload = JSON.stringify({ session_id: sessionId, transcript_path: file, cwd, hook_event_name: event, ...extra })
  for (const group of settings.hooks?.[event] ?? [])
    for (const h of group.hooks ?? [])
      if (h.type === 'command') spawnSync('/bin/sh', ['-c', h.command], { input: payload, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 })
}
fire('SessionStart', { source: source === 'resume' ? 'resume' : 'startup' })
if (source !== 'resume') {
  fire('UserPromptSubmit', { prompt: 'hello' })
  fire('Stop', { stop_hook_active: false })
}
