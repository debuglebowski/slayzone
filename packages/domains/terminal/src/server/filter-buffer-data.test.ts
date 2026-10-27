/**
 * Tests for filterBufferData (underline stripping from PTY output)
 */
import { expect, test } from 'vitest'
import { filterBufferData } from './filter-buffer-data'
import { stripUnderlineCodes } from '../shared/strip-underline'

// Basic underline stripping
test('strips standalone SGR 4 (underline)', () => {
  expect(filterBufferData('\x1b[4m')).toBe('')
})

test('strips SGR 4 with subparameters (curly underline 4:3)', () => {
  expect(filterBufferData('\x1b[4:3m')).toBe('')
})

test('strips all underline variants 4:1 through 4:5', () => {
  for (let i = 1; i <= 5; i++) {
    expect(filterBufferData(`\x1b[4:${i}m`), `4:${i}`).toBe('')
  }
})

test('strips double underline (4:2)', () => {
  expect(filterBufferData('\x1b[4:2m')).toBe('')
})

// Combined SGR codes
test('strips underline from combined codes (bold+underline+red)', () => {
  expect(filterBufferData('\x1b[1;4;31m')).toBe('\x1b[1;31m')
})

test('strips curly underline from combined codes', () => {
  expect(filterBufferData('\x1b[1;4:3;32m')).toBe('\x1b[1;32m')
})

test('preserves other codes when underline removed', () => {
  expect(filterBufferData('\x1b[1;4;31;42m')).toBe('\x1b[1;31;42m')
})

// Edge cases
test('preserves SGR 24 (underline off) — not the same as SGR 4', () => {
  expect(filterBufferData('\x1b[24m')).toBe('\x1b[24m')
})

test('preserves SGR 0 (reset)', () => {
  expect(filterBufferData('\x1b[0m')).toBe('\x1b[0m')
})

test('preserves bare reset ESC[m', () => {
  expect(filterBufferData('\x1b[m')).toBe('\x1b[m')
})

test('preserves color codes unchanged', () => {
  expect(filterBufferData('\x1b[31m')).toBe('\x1b[31m')
  expect(filterBufferData('\x1b[38;5;200m')).toBe('\x1b[38;5;200m')
  expect(filterBufferData('\x1b[38;2;100;150;200m')).toBe('\x1b[38;2;100;150;200m')
})

test('preserves bold, italic, inverse, strikethrough', () => {
  expect(filterBufferData('\x1b[1m')).toBe('\x1b[1m')
  expect(filterBufferData('\x1b[3m')).toBe('\x1b[3m')
  expect(filterBufferData('\x1b[7m')).toBe('\x1b[7m')
  expect(filterBufferData('\x1b[9m')).toBe('\x1b[9m')
})

test('preserves plain text unchanged', () => {
  expect(filterBufferData('hello world')).toBe('hello world')
})

test('handles mixed text and SGR codes', () => {
  expect(filterBufferData('hello \x1b[1;4;31mworld\x1b[0m')).toBe('hello \x1b[1;31mworld\x1b[0m')
})

test('strips underline code 44 is NOT stripped (it is bg blue)', () => {
  expect(filterBufferData('\x1b[44m')).toBe('\x1b[44m')
})

test('handles SGR 4 alone in combined becoming empty', () => {
  expect(filterBufferData('\x1b[4m')).toBe('')
})

// OSC stripping
test('strips title-setting OSC sequences', () => {
  expect(filterBufferData('\x1b]0;my title\x07')).toBe('')
  expect(filterBufferData('\x1b]2;my title\x07')).toBe('')
})

test('strips clipboard OSC sequences', () => {
  expect(filterBufferData('\x1b]52;c;base64data\x07')).toBe('')
})

test('preserves non-title OSC sequences', () => {
  // OSC 7 (cwd notification) should pass through
  expect(filterBufferData('\x1b]7;file:///path\x07')).toBe('\x1b]7;file:///path\x07')
})

// RGB/256 color combined with underline
test('strips underline from RGB color sequence', () => {
  expect(filterBufferData('\x1b[38;2;100;150;200;4m')).toBe('\x1b[38;2;100;150;200m')
})

test('strips underline from 256-color sequence', () => {
  expect(filterBufferData('\x1b[38;5;200;4m')).toBe('\x1b[38;5;200m')
})

test('strips curly underline from RGB color sequence', () => {
  expect(filterBufferData('\x1b[38;2;100;150;200;4:3m')).toBe('\x1b[38;2;100;150;200m')
})

test('strips underline between color params', () => {
  expect(filterBufferData('\x1b[1;4;38;5;200m')).toBe('\x1b[1;38;5;200m')
})

// Regression: multiple underlines in one stream
test('strips multiple underline sequences in one buffer', () => {
  expect(filterBufferData('\x1b[4mfoo\x1b[0m bar \x1b[4:3mbaz\x1b[0m')).toBe(
    'foo\x1b[0m bar baz\x1b[0m'
  )
})

// Split sequence simulation — server filter applied per chunk, client filter on joined batch
test('split sequence: server filter misses split escape', () => {
  // Server processes chunks independently — split escape slips through
  const chunk1 = filterBufferData('hello\x1b[')
  const chunk2 = filterBufferData('4mworld')
  expect(chunk1, 'chunk1 preserves partial escape').toBe('hello\x1b[')
  expect(chunk2, 'chunk2 passes through unmatched').toBe('4mworld')
})

test('split sequence: client-side join + filter catches it', () => {
  // Client batches chunks per rAF frame, joins, then filters — catches the split
  const chunk1 = filterBufferData('hello\x1b[')
  const chunk2 = filterBufferData('4mworld')
  const joined = stripUnderlineCodes(chunk1 + chunk2)
  expect(joined, 'joined + filtered strips underline').toBe('helloworld')
})

// SGR sub-parameter safety — `4` as a color sub-parameter must NOT be stripped.
// `38`/`48`/`58` followed by `5;<idx>` or `2;<r>;<g>;<b>` consume those tokens as a
// color spec; a `4` appearing as the index or an RGB component is not SGR underline.
test('preserves 256-color fg index 4', () => {
  expect(filterBufferData('\x1b[38;5;4m')).toBe('\x1b[38;5;4m')
})

test('preserves 256-color bg index 4', () => {
  expect(filterBufferData('\x1b[48;5;4m')).toBe('\x1b[48;5;4m')
})

test('preserves underline-color (SGR 58) index 4', () => {
  expect(filterBufferData('\x1b[58;5;4m')).toBe('\x1b[58;5;4m')
})

test('preserves RGB fg with component 4', () => {
  expect(filterBufferData('\x1b[38;2;4;120;200m')).toBe('\x1b[38;2;4;120;200m')
  expect(filterBufferData('\x1b[38;2;120;4;200m')).toBe('\x1b[38;2;120;4;200m')
  expect(filterBufferData('\x1b[38;2;4;4;4m')).toBe('\x1b[38;2;4;4;4m')
})

test('strips standalone underline but keeps color index 4 in same sequence', () => {
  expect(filterBufferData('\x1b[1;4;38;5;4m')).toBe('\x1b[1;38;5;4m')
})

test('preserves colon-form extended color with index 4', () => {
  expect(filterBufferData('\x1b[38:5:4m')).toBe('\x1b[38:5:4m')
})

// Device-status queries must NEVER reach the replayable buffer. A stored query
// is re-answered by xterm.js on every replay, and those answers are forwarded to
// the live process as if typed. Claude Code polls DECXCPR (`?6n`) every 200ms and
// reads a row=1 answer as "screen externally wiped" → submits `/clear` → new
// session. Buffers on live tasks held 24k–35k copies before this filter.
test('strips DECXCPR ?6n — the spontaneous-/clear trigger', () => {
  expect(filterBufferData('\x1b[?6n')).toBe('')
})

test('strips an accumulated ?6n poll burst but keeps surrounding output', () => {
  const burst = '\x1b[?6n'.repeat(200)
  expect(filterBufferData(`\x1b[1;31mhello\x1b[0m${burst}world`)).toBe(
    '\x1b[1;31mhello\x1b[0mworld'
  )
})

test('strips plain CPR 6n and DSR 5n from the buffer', () => {
  expect(filterBufferData('\x1b[6n')).toBe('')
  expect(filterBufferData('\x1b[5n')).toBe('')
})

test('preserves alt-screen + cursor-visibility private modes (not queries)', () => {
  expect(filterBufferData('\x1b[?1049h')).toBe('\x1b[?1049h')
  expect(filterBufferData('\x1b[?1049l')).toBe('\x1b[?1049l')
  expect(filterBufferData('\x1b[?25l')).toBe('\x1b[?25l')
})

// filterBufferData's output is ALSO what streams live to the renderer, so the
// strip set must stay narrow: queries the renderer legitimately answers have to
// survive, or capability detection breaks.
test('preserves renderer-answered queries (DECRQM / XTVERSION)', () => {
  expect(filterBufferData('\x1b[?2026$p')).toBe('\x1b[?2026$p')
  expect(filterBufferData('\x1b[>0q')).toBe('\x1b[>0q')
})

test('preserves cursor movement adjacent to stripped queries', () => {
  expect(filterBufferData('\x1b[10;20H\x1b[?6n\x1b[2J')).toBe('\x1b[10;20H\x1b[2J')
})

// ---------------------------------------------------------------------------
// D3 — an implicit SGR reset must survive underline stripping
//
// `ESC[;4m` is "reset, then underline": the empty first parameter defaults to 0.
// Dropping the `4` left `kept = ['']`, which joins to `''` and hit the falsy
// branch — emitting nothing and destroying the reset, so whatever colour/bold was
// active bled into the following text. `ESC[m` (bare = reset) is the correct
// remainder. Contrast `ESC[0;4m`, whose explicit 0 survives and already worked.
// ---------------------------------------------------------------------------

test('implicit reset survives when the underline is stripped (ESC[;4m → ESC[m)', () => {
  expect(filterBufferData('\x1b[;4munderlined')).toBe('\x1b[munderlined')
})

test('explicit reset + underline keeps the reset (regression guard)', () => {
  expect(filterBufferData('\x1b[0;4mtext')).toBe('\x1b[0mtext')
})

test('a bare underline with no other params still strips to nothing', () => {
  expect(filterBufferData('\x1b[4mtext')).toBe('text')
})

test('multiple empty params are preserved', () => {
  // `ESC[;;4m` is reset;reset;underline — the two implicit resets remain.
  expect(filterBufferData('\x1b[;;4mtext')).toBe('\x1b[;mtext')
})

// ---------------------------------------------------------------------------
// D4 — full ITU T.416 colour-selector set
//
// The extended-colour walk only understood selector `5` (indexed) and `2` (RGB).
// Selector `4` is CMYK, and it fell through to the generic token loop, where its
// FIRST COMPONENT — a literal `4` — was mistaken for SGR 4 underline and eaten,
// shifting every following component and mangling the colour.
// ---------------------------------------------------------------------------

test('CMYK extended colour (selector 4) survives intact', () => {
  expect(filterBufferData('\x1b[38;4;10;20;30;40mtext')).toBe('\x1b[38;4;10;20;30;40mtext')
})

test('CMY extended colour (selector 3) survives intact', () => {
  expect(filterBufferData('\x1b[38;3;10;20;30mtext')).toBe('\x1b[38;3;10;20;30mtext')
})

test('transparent / implementation-defined selectors 0 and 1 survive', () => {
  expect(filterBufferData('\x1b[38;0mtext')).toBe('\x1b[38;0mtext')
  expect(filterBufferData('\x1b[38;1mtext')).toBe('\x1b[38;1mtext')
})

test('a CMYK component that is literally 4 is not treated as underline', () => {
  // Every component set to 4 — the pathological case for the old walk.
  expect(filterBufferData('\x1b[48;4;4;4;4;4mtext')).toBe('\x1b[48;4;4;4;4;4mtext')
})

test('underline after a CMYK spec is still stripped', () => {
  // The walk must resume filtering once the colour spec is consumed.
  expect(filterBufferData('\x1b[38;4;1;2;3;4;4mtext')).toBe('\x1b[38;4;1;2;3;4mtext')
})

test('indexed and RGB colours still survive (regression guard)', () => {
  expect(filterBufferData('\x1b[38;5;4mtext')).toBe('\x1b[38;5;4mtext')
  expect(filterBufferData('\x1b[38;2;4;4;4mtext')).toBe('\x1b[38;2;4;4;4mtext')
})

test('underline color 58 with CMYK survives', () => {
  expect(filterBufferData('\x1b[58;4;9;8;7;6mtext')).toBe('\x1b[58;4;9;8;7;6mtext')
})
