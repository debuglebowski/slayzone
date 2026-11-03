/**
 * Mock merge-ai for handler contract tests.
 * Mutable `_mock` object lets each test control return values.
 */
export const _mock = {
  runAiCommand: async (_mode: string, _prompt: string): Promise<string> => {
    return 'SUMMARY: Mock summary\n---RESOLUTION---\nresolved content'
  }
}

export async function runAiCommand(mode: string, prompt: string): Promise<string> {
  return _mock.runAiCommand(mode, prompt)
}

/** The real module routes the CLI to a computer; the mock has nothing to route. */
export function setAiCommandRunner(_runner: unknown): void {}
