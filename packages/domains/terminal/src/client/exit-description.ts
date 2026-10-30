/**
 * The dead-session overlay's one-line explanation of why a session ended.
 *
 * `exitReason` is the lifecycle cause the exit code cannot carry, set by the hub,
 * the routing backend or the computer (`startup-timeout`, `computer-restarted`,
 * …). Without it the overlay could only print the code, and a code the HUB made
 * up (-1 when it gave up on a session) read as the agent crashing.
 *
 * @module terminal/client/exit-description
 */

const REASON_TEXT: Record<string, string> = {
  'startup-timeout': 'The agent printed nothing while starting and was stopped.',
  'computer-restarted': 'The computer running this agent restarted.',
  'spawn-failed': "The computer couldn't start the agent.",
  'adopt-failed': "The computer couldn't start the agent.",
  'project-not-placed':
    "This project has no folder on that computer yet. Set it in the project's settings, then retry.",
  'reattach-timeout': 'Lost contact with the computer running this agent.',
  'exited-while-detached': 'The agent exited while its computer was unreachable.',
  // The client's own watchdog gave up on a session the hub no longer reports.
  'no-response': 'No response from the agent while it was starting.'
}

export function describeExit(exitCode: number | null, exitReason: string | null): string {
  const known = exitReason ? REASON_TEXT[exitReason] : undefined
  return known ?? `Process exited with code ${String(exitCode)}`
}
