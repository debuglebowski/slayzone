/**
 * Compare agent CLI versions (`2.1.312`, `2.1.312 (Claude Code)`, `2.2.0-beta.1`).
 * Numeric per dotted part; a pre-release sorts below its release.
 *
 * @module terminal/server/runtime/cli-version
 */

function parse(version: string): { parts: number[]; pre: boolean } | null {
  const m = /(\d+(?:\.\d+)*)(-[0-9A-Za-z.-]+)?/.exec(version)
  if (!m) return null
  return { parts: m[1].split('.').map(Number), pre: Boolean(m[2]) }
}

/** True when `version` is older than `minimum`. Unparseable → false (never nag on noise). */
export function isCliVersionBelow(version: string, minimum: string): boolean {
  const a = parse(version)
  const b = parse(minimum)
  if (!a || !b) return false
  const len = Math.max(a.parts.length, b.parts.length)
  for (let i = 0; i < len; i++) {
    const x = a.parts[i] ?? 0
    const y = b.parts[i] ?? 0
    if (x !== y) return x < y
  }
  return a.pre && !b.pre
}
