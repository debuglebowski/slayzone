/** Restores the Buffer pool `./buffer-pool-off` turned off for the graphemes addon's load. */
const holder = globalThis as { __slzBufferPoolSize?: number }
if (typeof Buffer !== 'undefined' && holder.__slzBufferPoolSize !== undefined) {
  Buffer.poolSize = holder.__slzBufferPoolSize
  delete holder.__slzBufferPoolSize
}
