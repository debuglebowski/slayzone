/**
 * Normalize a `ws` message payload (`Buffer | ArrayBuffer | Buffer[] | string`)
 * to a UTF-8 string. Typed as `unknown` so shared code carries no ws types.
 *
 * @module runner/shared/ws-data
 */

export function wsDataToText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data as readonly Uint8Array[]).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return (data as Buffer).toString('utf8')
}
