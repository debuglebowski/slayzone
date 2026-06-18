/**
 * Custom Node.js module resolve hook that redirects external dependencies to mocks.
 * Usage: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts <test>
 */

const mockElectronUrl = new URL('./mock-electron.ts', import.meta.url).href
const mockLinearClientUrl = new URL('./mock-linear-client.ts', import.meta.url).href
const mockMergeAiUrl = new URL('./mock-merge-ai.ts', import.meta.url).href
const mockDagreUrl = new URL('./mock-dagre.ts', import.meta.url).href

// Redirect map: specifier patterns → mock URL
// tsx may append .ts/.js extensions, so match with or without
// Match a relative specifier (any `./` or `../` depth) for a given module
// basename, with or without a tsx-appended .ts/.js extension. The integration
// linear-client is imported as `./linear-client` from handlers-store.ts AND as
// `../linear-client` from the adapter, so a bare `=== './linear-client'` check
// missed the adapter path — both must redirect to the same mock.
const matchesRelative = (basename: string) => (s: string): boolean =>
  /^\.\.?\//.test(s) && new RegExp(`(^|/)${basename}(\\.ts|\\.js)?$`).test(s)

const redirects: Array<{ match: (s: string) => boolean; url: string }> = [
  { match: matchesRelative('linear-client'), url: mockLinearClientUrl },
  {
    match: (s) => s === './merge-ai' || s === './merge-ai.ts' || s === './merge-ai.js',
    url: mockMergeAiUrl
  },
  { match: (s) => s === '@dagrejs/dagre', url: mockDagreUrl }
]

export function resolve(
  specifier: string,
  context: { parentURL?: string; conditions: string[] },
  nextResolve: (specifier: string, context: unknown) => unknown
) {
  if (specifier === 'electron') {
    return { url: mockElectronUrl, shortCircuit: true }
  }

  for (const r of redirects) {
    if (r.match(specifier)) {
      return { url: r.url, shortCircuit: true }
    }
  }

  return nextResolve(specifier, context)
}
