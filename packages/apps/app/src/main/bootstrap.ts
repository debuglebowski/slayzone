// The packaged app's entry (package.json `main`). A static import loads before the
// importing file runs, so code at the top of index.ts runs only after every library
// it imports from node_modules has loaded. This file loads index.ts only once
// NODE_ENV is set, so no library ever sees it unset. Electron waits for this
// top-level await before `ready`, as it did for index.ts's own static imports.
// Unpackaged runs (dev, e2e) may launch index.ts directly: there it is a no-op.
import './packaged-node-env'

await import('./index')
