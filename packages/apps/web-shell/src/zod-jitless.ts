// The web shell's `zod`: vite.config.ts aliases every bare `zod` import in this
// bundle to this module, so it is a DEPENDENCY of every module that builds a schema
// and therefore runs first. Import order alone is not enough: the bundler evaluates
// a shared chunk (zod plus the schema modules) before the entry chunk's own body.
//
// zod 4 decides when an object schema is built whether to compile its parser with
// `new Function`, probing once whether that is allowed. The hub's CSP has no
// 'unsafe-eval' (apps/hub/src/security-headers.ts), so the probe throws: zod catches
// it and parses without compiling, but the browser still reports a CSP violation.
// `jitless` skips the probe. Parsing is unchanged: compiling was never allowed here.
//
// `zod/v4` is the same module graph as `zod` (one global config), and the alias
// matches only the bare specifier, so this import is not aliased back to itself.
import { config } from 'zod/v4'

config({ jitless: true })

export * from 'zod/v4'
export { z, default } from 'zod/v4'
