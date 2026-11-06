/**
 * Where the test panel's file scan runs: on the project's computer (resolved from
 * the checkout path the client names, else the project). The hub's composition wires
 * {@link setTestScanRouting}; with no computer (or unwired), "connect a computer" on
 * every hub — the hub's own disk is never scanned.
 */
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { ScanResult } from '../shared/types'
import type { ScanCategory } from './scanner'

export interface TestScanRouting {
  computerFor(target: { projectPath: string; projectId: string }): Promise<string | null>
  scan(
    computerId: string,
    input: { projectPath: string; categories: ScanCategory[] }
  ): Promise<ScanResult>
}

let routing: TestScanRouting | null = null

export function setTestScanRouting(next: TestScanRouting | null): void {
  routing = next
}

export async function scanTestFilesWhereTheyAre(
  target: { projectPath: string; projectId: string },
  categories: readonly ScanCategory[]
): Promise<ScanResult> {
  const plain = categories.map(({ id, pattern }) => ({ id, pattern }))
  const computerId = routing ? await routing.computerFor(target) : null
  if (computerId != null && routing) {
    return routing.scan(computerId, { projectPath: target.projectPath, categories: plain })
  }
  return refuseNoComputer({ op: 'testPanel.scanFiles' })
}
