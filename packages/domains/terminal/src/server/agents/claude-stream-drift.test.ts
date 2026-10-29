/**
 * Stream-format drift check (chat plan 0.5): every stdout line of every recorded
 * real-CLI run goes through the adapter, and a shape the adapter does not
 * recognise fails here instead of silently disappearing from chat.
 *
 * After a CLI update: re-record (claude-stream-recorder.live.ts), run this. A new
 * failure means the CLI started sending something new — handle it in
 * claude-code-adapter.ts, or list it below with the reason it is safe to drop.
 *
 * Also checks the fake CLI accepts the argv the adapter really builds, so the
 * e2e harness cannot drift from the transport either.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createFakeClaude,
  FAKE_CLAUDE_EXIT,
  listTranscripts,
  transcriptStdout
} from '@slayzone/test-utils/fake-claude'
import { claudeCodeAdapter } from './claude-code-adapter'

const LEGACY_FIXTURES = fileURLToPath(
  new URL('../../../test/fixtures/claude-stream', import.meta.url)
)

/**
 * Shapes the adapter parses to `{kind:'unknown'}` today, each with the plan item
 * that will give it a surface. Persisted, never drawn (chat-timeline drops them).
 */
const KNOWN_UNHANDLED: Record<string, string> = {
  // Estimated thinking-token progress while the model thinks (several per turn
  // with thinking on; the chatui-* fixtures record it). Plan 3.2 (thinking
  // display) gives it a surface or a deliberate drop.
  'system/thinking_tokens': 'thinking progress, plan 3.2'
}

/** Shapes the adapter deliberately returns `null` for, and why that is safe. */
const KNOWN_IGNORED: Record<string, string> = {
  // The SDK echoes user text back; chat already records its own `user-message`.
  // NOTE the same shape carries the "[Request interrupted by user…]" notice
  // (interrupt-* transcripts), which is dropped too.
  'user/text': 'echo of a message chat already recorded',
  // CLI-synthesized context: the /compact summary and replayed local-command
  // stdout. The compaction itself surfaces through `system/status`
  // (compact-status) + `compact_boundary`, command output through
  // `local_command_output` / `local_command_run`.
  'user/string': 'synthesized context, surfaced through other events',
  // `requesting` (per API call) and a bare `{status:null}` have no chat
  // surface. Compaction frames become compact-status, a `permissionMode` frame
  // permission-mode-changed.
  'system/status': 'status without compaction or permission mode',
  // Hook runs (the chatui-* fixtures run with hooks installed): the start frame
  // carries nothing to show; a response is dropped only when the hook changed
  // nothing and told the model nothing — the rest parse to `hook-output`
  // (claude-hook-output.ts).
  'system/hook_started': 'hook start frame',
  'system/hook_response': 'a quiet hook run (no block, failure or context)',
  // Sub-agent progress ticks: `task_started` / `task_notification` carry the signal.
  'system/task_progress': 'sub-agent progress tick',
  // Usage/stop_reason update mid-stream; the final `result` carries both.
  'stream_event/message_delta': 'superseded by result'
}

type Json = Record<string, unknown>

/** A stable name for a line's shape: type plus the discriminators the adapter reads. */
function shapeKey(obj: Json): string {
  const type = String(obj.type)
  switch (type) {
    case 'system':
    case 'result':
      return `${type}/${String(obj.subtype)}`
    case 'assistant': {
      const content =
        (obj.message as { content?: Array<{ type?: string }> } | undefined)?.content ?? []
      return content.length > 1 ? 'assistant/multi-block' : `assistant/${String(content[0]?.type)}`
    }
    case 'user': {
      const content = (obj.message as { content?: unknown } | undefined)?.content
      if (typeof content === 'string') return 'user/string'
      return `user/${String((content as Array<{ type?: string }> | undefined)?.[0]?.type)}`
    }
    case 'stream_event': {
      const inner = (obj.event ?? {}) as Json
      const block =
        (inner.content_block as Json | undefined)?.type ?? (inner.delta as Json | undefined)?.type
      return block
        ? `stream_event/${String(inner.type)}/${String(block)}`
        : `stream_event/${String(inner.type)}`
    }
    case 'control_request':
      return `control_request/${String((obj.request as Json | undefined)?.subtype)}`
    case 'control_response':
      return `control_response/${String((obj.response as Json | undefined)?.subtype)}`
    default:
      return type
  }
}

interface Source {
  name: string
  lines: string[]
}

const sources: Source[] = [
  ...listTranscripts().map(({ recipe, file }) => ({
    name: `transcript ${recipe}`,
    lines: transcriptStdout(file)
  })),
  ...fs
    .readdirSync(LEGACY_FIXTURES)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .map((f) => ({
      name: `fixture ${f}`,
      lines: fs
        .readFileSync(path.join(LEGACY_FIXTURES, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
    }))
]

describe('claude stream-json drift', () => {
  it('has recorded transcripts to check', () => {
    expect(listTranscripts().length).toBeGreaterThan(0)
  })

  // Which listed outcome each shape actually produced, so a stale entry is caught
  // per outcome: a shape the adapter now PARSES must leave both lists.
  const seenUnknown = new Set<string>()
  const seenDropped = new Set<string>()
  for (const source of sources) {
    it(`${source.name}: every line is recognised or deliberately dropped`, () => {
      const problems: string[] = []
      for (const line of source.lines) {
        let obj: Json
        try {
          obj = JSON.parse(line) as Json
        } catch {
          problems.push(`not JSON: ${line.slice(0, 120)}`)
          continue
        }
        const key = shapeKey(obj)
        const ev = claudeCodeAdapter.parseLine(line)
        if (ev?.kind === 'unknown') {
          seenUnknown.add(key)
          if (!(key in KNOWN_UNHANDLED)) problems.push(`unrecognised (${ev.reason}): ${key}`)
        } else if (ev === null) {
          seenDropped.add(key)
          if (!(key in KNOWN_IGNORED)) problems.push(`silently dropped: ${key}`)
        }
      }
      expect(problems).toEqual([])
    })
  }

  it('lists no shape that no longer produces its listed outcome', () => {
    const stale = [
      ...Object.keys(KNOWN_UNHANDLED)
        .filter((k) => !seenUnknown.has(k))
        .map((k) => `KNOWN_UNHANDLED ${k}`),
      ...Object.keys(KNOWN_IGNORED)
        .filter((k) => !seenDropped.has(k))
        .map((k) => `KNOWN_IGNORED ${k}`)
    ]
    expect(stale).toEqual([])
  })
})

describe('fake CLI ↔ adapter argv', () => {
  for (const resume of [false, true]) {
    it(`the fake accepts the adapter's ${resume ? '--resume' : '--session-id'} argv`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-parity-'))
      const fake = createFakeClaude({ root })
      try {
        fake.setScenario({ processes: [{ defaultTurn: [] }] })
        const { args } = claudeCodeAdapter.buildSpawnArgs({
          sessionId: 'parity-session',
          resume,
          cwd: root,
          providerFlags: ['--permission-mode', 'acceptEdits', '--model', 'haiku']
        })
        // stdin closed at once → the fake exits 0 once it has validated argv.
        const res = spawnSync(path.join(fake.binDir, 'claude'), args, {
          cwd: root,
          input: '',
          timeout: 30_000
        })
        expect(res.status, String(res.stderr)).not.toBe(FAKE_CLAUDE_EXIT.argvDrift)
        expect(res.status).toBe(0)
        const run = fake.current().run(0)
        expect(run?.sessionId).toBe('parity-session')
        expect(run?.resumed).toBe(resume)
      } finally {
        fake.dispose()
      }
    })
  }
})
