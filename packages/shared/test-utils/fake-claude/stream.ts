/**
 * Token streaming for the fake `claude` CLI (`--include-partial-messages`, plan
 * item 3.2). Builders for the `stream_event` frames CLI 2.1.312 writes, and a
 * helper that plays one assistant message block by block in the real order
 * (spike item 9): `message_start`, then per block `content_block_start` → its
 * deltas → the consolidated `assistant` event for the block → `content_block_stop`,
 * then `message_delta` + `message_stop`.
 *
 * @module test-utils/fake-claude/stream
 */
import { randomUUID } from 'node:crypto'
import { ev, type Step, type StreamEvent } from './scenario'

function frame(event: Record<string, unknown>, parentToolUseId?: string): StreamEvent {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: parentToolUseId ?? null,
    session_id: '{{sessionId}}',
    uuid: randomUUID()
  }
}

/** One `stream_event` frame each (`index` = the block's index in its message). */
export const streamEv = {
  messageStart(messageId: string, opts: { parentToolUseId?: string } = {}): StreamEvent {
    return frame(
      {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: '{{model}}',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      },
      opts.parentToolUseId
    )
  },
  textStart(index: number): StreamEvent {
    return frame({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
  },
  thinkingStart(index: number): StreamEvent {
    return frame({
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' }
    })
  },
  toolUseStart(index: number, tool: { id: string; name: string }): StreamEvent {
    return frame({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} }
    })
  },
  textDelta(index: number, text: string): StreamEvent {
    return frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
  },
  /** `estimated_tokens` is set without `--thinking-display summarized` (text stays empty). */
  thinkingDelta(
    index: number,
    thinking: string,
    estimatedTokens: number | null = null
  ): StreamEvent {
    return frame({
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking, estimated_tokens: estimatedTokens }
    })
  },
  signatureDelta(index: number): StreamEvent {
    return frame({
      type: 'content_block_delta',
      index,
      delta: { type: 'signature_delta', signature: 'fake-signature' }
    })
  },
  inputJsonDelta(index: number, partialJson: string): StreamEvent {
    return frame({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partialJson }
    })
  },
  blockStop(index: number): StreamEvent {
    return frame({ type: 'content_block_stop', index })
  },
  messageDelta(stopReason: 'end_turn' | 'tool_use' = 'end_turn'): StreamEvent {
    return frame({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 }
    })
  },
  messageStop(): StreamEvent {
    return frame({ type: 'message_stop' })
  }
}

/** One block of a streamed message: its chunks, in order. */
export type StreamBlock =
  | { text: string[] }
  /** Summarized thinking (`--thinking-display summarized`); `[]` = omitted display. */
  | { thinking: string[] }
  /** Tool input streamed as JSON text; `chunks` default to the input JSON cut in 3. */
  | { toolUse: { id: string; name: string; input: Record<string, unknown>; chunks?: string[] } }

export interface StreamMessageOpts {
  /** Gap between consecutive deltas (and before each block's first one). Default 0. */
  gapMs?: number
  /**
   * Leave the message open after the last block's deltas: no consolidated event,
   * no stops (a stream cut short — reload or kill mid-block).
   */
  open?: boolean
}

/**
 * Steps that stream ONE assistant message the way the real CLI does. The saved
 * `assistant` events carry `messageId`, so the app can match them to the deltas.
 */
export function streamMessage(
  messageId: string,
  blocks: StreamBlock[],
  opts: StreamMessageOpts = {}
): Step[] {
  const gap = opts.gapMs ?? 0
  const steps: Step[] = [{ emit: streamEv.messageStart(messageId) }]
  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1
    if ('text' in block) {
      steps.push({ emit: streamEv.textStart(index) })
      pushDeltas(
        steps,
        block.text.map((c) => streamEv.textDelta(index, c)),
        gap
      )
      if (opts.open && last) return
      steps.push({
        emit: [ev.text(block.text.join(''), { messageId }), streamEv.blockStop(index)]
      })
    } else if ('thinking' in block) {
      steps.push({ emit: streamEv.thinkingStart(index) })
      const deltas =
        block.thinking.length > 0
          ? block.thinking.map((c) => streamEv.thinkingDelta(index, c))
          : [streamEv.thinkingDelta(index, '', 50)]
      pushDeltas(steps, [...deltas, streamEv.signatureDelta(index)], gap)
      if (opts.open && last) return
      steps.push({
        emit: [ev.thinking(block.thinking.join(''), { messageId }), streamEv.blockStop(index)]
      })
    } else {
      const { id, name, input } = block.toolUse
      const chunks = block.toolUse.chunks ?? splitInThree(JSON.stringify(input))
      steps.push({ emit: streamEv.toolUseStart(index, { id, name }) })
      pushDeltas(
        steps,
        chunks.map((c) => streamEv.inputJsonDelta(index, c)),
        gap
      )
      if (opts.open && last) return
      steps.push({ emit: [ev.toolUse({ id, name, input, messageId }), streamEv.blockStop(index)] })
    }
  })
  if (opts.open) return steps
  const endsWithTool = blocks.length > 0 && 'toolUse' in blocks[blocks.length - 1]
  steps.push({
    emit: [streamEv.messageDelta(endsWithTool ? 'tool_use' : 'end_turn'), streamEv.messageStop()]
  })
  return steps
}

function pushDeltas(steps: Step[], deltas: StreamEvent[], gapMs: number): void {
  for (const delta of deltas) {
    if (gapMs > 0) steps.push({ sleep: gapMs })
    steps.push({ emit: delta })
  }
}

function splitInThree(text: string): string[] {
  const a = Math.floor(text.length / 3)
  const b = Math.floor((2 * text.length) / 3)
  return [text.slice(0, a), text.slice(a, b), text.slice(b)].filter((c) => c.length > 0)
}
