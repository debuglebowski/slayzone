/**
 * Test-only: `vi.mock('./trpc', trpcPassthroughMock)` — this domain's `./trpc` served
 * by the test's `@slayzone/transport/client` mock, unscoped (no panel scope). The
 * scoped and unscoped hooks both delegate to the transport mock at CALL time, so a
 * test only has to mock the hooks its code path actually calls.
 */
export async function trpcPassthroughMock(): Promise<Record<string, unknown>> {
  const t = (await import('@slayzone/transport/client')) as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >
  return {
    ...t,
    useUnscopedTRPC: (...args: unknown[]) => t.useTRPC(...args),
    useUnscopedTRPCClient: (...args: unknown[]) => t.useTRPCClient(...args),
    useGitScope: () => null
  }
}
