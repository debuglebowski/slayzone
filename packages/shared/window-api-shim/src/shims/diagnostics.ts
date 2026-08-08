// cap-shell-2 — console fallback. Proper telemetry pipeline (sidecar diagnostics
// channel + DiagnosticsHost mojom) lands in cap-shell-7.

export const diagnosticsShim = {
  recordClientError: (payload: unknown): Promise<void> => {
    // eslint-disable-next-line no-console
    console.error('[shell] client error:', payload)
    return Promise.resolve()
  },
  recordClientEvent: (payload: unknown): Promise<void> => {
    // eslint-disable-next-line no-console
    console.debug('[shell] client event:', payload)
    return Promise.resolve()
  },
  getConfig: async (): Promise<unknown> => ({}),
  setConfig: async (_cfg: unknown): Promise<void> => {
    // No diagnostics config exists in the shell yet — `getConfig` returns `{}`,
    // so accepting and dropping a write keeps the surface shape until the
    // cap-shell-7 diagnostics channel gives it somewhere to land.
  },
  export: async (): Promise<string> => ''
}
