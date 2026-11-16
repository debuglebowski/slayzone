/**
 * Whether a task's terminal runs on THIS device — the only case where a path to a
 * file this device just saved (the browser camera button) means anything inside it.
 *
 *  - The task's hub is this device's own local hub: its co-located computer is this
 *    device (`onHubMachine`, from `computers.resolveTaskComputer`).
 *  - Another hub: this device's computer has its own id there
 *    (`electronBootstrap.getLocalComputerHubs()`); the terminal must run on that one.
 */
export function terminalOnThisDevice(input: {
  hubIsLocal: boolean
  resolved: { computerId: string | null; onHubMachine?: boolean }
  /** This device's computer id on the task's hub (remote hubs), if it joined there. */
  myComputerIdOnHub: string | null
}): boolean {
  if (input.hubIsLocal) return input.resolved.onHubMachine === true
  return input.resolved.computerId !== null && input.resolved.computerId === input.myComputerIdOnHub
}
