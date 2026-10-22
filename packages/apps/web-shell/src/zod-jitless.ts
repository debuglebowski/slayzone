// main.tsx's FIRST import, so it runs before any module builds a schema.
//
// zod 4 decides when an object schema is built whether to compile its parser with
// `new Function`, probing once whether that is allowed. The hub's CSP has no
// 'unsafe-eval' (apps/hub/src/security-headers.ts), so the probe throws: zod catches
// it and parses without compiling, but the browser still reports a CSP violation.
// `jitless` skips the probe. Parsing is unchanged: compiling was never allowed here.
import { z } from 'zod'

z.config({ jitless: true })
