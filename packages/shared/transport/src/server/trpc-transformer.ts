import superjson from 'superjson'
import type { SuperJSONResult } from 'superjson'

/**
 * The hub's tRPC transformer: superjson on the wire, with a fast path for the
 * response side.
 *
 * WHY. superjson's `serialize` walks every value with per-node path arrays,
 * an ancestor scan and a dozen type probes (`isTypedArray`, `isURL`,
 * registered-class lookups…). For the board load — ~2.4k tasks, ~6 MB — that is
 * ~80 ms of synchronous work on the hub's ONE event loop, the largest single
 * piece of a board response and the top frame in most of the hub's recorded
 * `server.event_loop_stall`s. Everything the hub returns is, in practice, plain
 * JSON data (SQLite rows, `JSON.parse` output, literals), for which superjson's
 * answer is always `{ json: <a deep copy> }` with no `meta`.
 *
 * WHAT. `serializeOutput` first checks — with one cheap recursive pass — that the
 * value is exactly such plain data; if so it returns `{ json: value }` (the value
 * itself; the copy superjson makes is only ever JSON-stringified, so its content
 * is what matters and it is identical). ANY value superjson would annotate or
 * treat specially falls back to `superjson.serialize`, so the produced wire bytes
 * are identical in every case — the client (plain `superjson`) cannot tell:
 * - non-finite numbers and `-0`, `undefined`, bigint, symbol, function;
 * - anything that is not a plain object (prototype `Object.prototype` or `null`)
 *   or a plain array: Date, Map, Set, RegExp, URL, Error, typed arrays, class
 *   instances;
 * - an object reachable twice (superjson emits `referentialEqualities`) or a
 *   cycle;
 * - the keys `__proto__` / `constructor` / `prototype` (superjson throws on them —
 *   the fallback keeps that refusal);
 * - an array with holes or extra non-index keys (superjson walks them).
 *
 * Inputs (client → hub) keep plain superjson both ways.
 */

const OBJECT_PROTO = Object.prototype
const ARRAY_PROTO = Array.prototype

function isPlainJsonData(value: unknown, seen: Set<object>): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      // NaN / ±Infinity / -0 carry a superjson 'number' annotation.
      return Number.isFinite(value) && !(value === 0 && 1 / value < 0)
    case 'object':
      break
    default:
      // undefined, bigint, symbol, function
      return false
  }
  if (value === null) return true
  // Second sighting = shared reference or cycle → superjson annotates it.
  if (seen.has(value)) return false
  seen.add(value)
  const proto = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (proto !== ARRAY_PROTO) return false
    const arr = value as unknown[]
    // Holes or extra own keys: superjson walks `Object.entries`, which differs.
    if (Object.keys(arr).length !== arr.length) return false
    for (let i = 0; i < arr.length; i++) {
      if (!isPlainJsonData(arr[i], seen)) return false
    }
    return true
  }
  if (proto !== OBJECT_PROTO && proto !== null) return false
  if (value === OBJECT_PROTO) return false
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false
    if (!isPlainJsonData(obj[key], seen)) return false
  }
  return true
}

/** `superjson.serialize`, minus the walk when the value is already plain JSON data. */
export function serializeOutput(value: unknown): SuperJSONResult {
  if (isPlainJsonData(value, new Set())) return { json: value as SuperJSONResult['json'] }
  return superjson.serialize(value)
}

export const trpcTransformer = {
  input: superjson,
  output: {
    serialize: serializeOutput,
    deserialize: superjson.deserialize
  }
}
