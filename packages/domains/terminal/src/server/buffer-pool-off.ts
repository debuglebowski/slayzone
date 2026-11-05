/**
 * Imported right BEFORE `@xterm/addon-unicode-graphemes` (`terminal-reply-mirror.ts`),
 * with `./buffer-pool-on` right after: ES modules evaluate in import order, in every
 * runtime and bundler this code ships through (Node/vitest, esbuild, rolldown).
 *
 * The addon decodes its width tables from a base64 literal with `Buffer.from(…,
 * 'base64')` at load — a buffer carved from Node's shared pool, at an offset set by
 * whatever this process allocated before — and reads it as if it started the pool.
 * It inflated garbage then: an endless loop (the computer froze at boot) or "Data
 * error", depending on what had loaded first (`node:https` alone was enough). With
 * pooling off for the length of that one synchronous load, the buffer is its own.
 */
const holder = globalThis as { __slzBufferPoolSize?: number }
if (typeof Buffer !== 'undefined') {
  holder.__slzBufferPoolSize = Buffer.poolSize
  Buffer.poolSize = 0
}
