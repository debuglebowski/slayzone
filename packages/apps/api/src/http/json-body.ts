import express, { type RequestHandler } from 'express'

/**
 * The ONE way this codebase builds an Express body parser: `express.json` with
 * `inflate: false`, so a request carrying `Content-Encoding` (gzip, deflate, br, zstd)
 * is answered 415 before any decompression stream exists.
 *
 * Why: body-parser < 2.4.0 leaves the decoder piped with no error listener after
 * reading a compressed body, so one compressed frame plus trailing bytes crashes the
 * process (GHSA-27r3-jxmh-p828) — before routing and before any auth gate. Refusing
 * compression also removes decompression as an amplifier against the size limit.
 * Nothing we ship compresses a request body (notify.sh's curl/wget, the `slay` CLI's
 * fetch, MCP clients, the web shell), so this changes no working caller. Keep it after
 * the body-parser bump: there is still no client that needs it.
 *
 * `json-body.test.ts` fails if a source file builds a parser any other way.
 */
export function jsonBodyParser(opts: { limit?: string } = {}): RequestHandler {
  return express.json({ ...opts, inflate: false })
}
