/**
 * Where the test panel's file scan runs: on the project's computer, under the
 * project's PATH SCOPE (§9 Phase 7b): the computer confines the scanned folder to
 * the project's own folder there. The hub never resolves a computer from a path —
 * it no longer knows whose a path is. The hub's composition wires
 * {@link setTestScanRouting}; with no computer (or unwired), "connect a computer" on
 * every hub — the hub's own disk is never scanned.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import { inPathScopeOf } from '@slayzone/platform/path-scope'
import type { ScanResult } from '../shared/types'
import type { ScanCategory } from './scanner'

export interface TestScanRouting {
  computerFor(target: { projectId: string }): Promise<string | null>
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
  db: SlayzoneDb,
  target: { projectPath: string; projectId: string },
  categories: readonly ScanCategory[]
): Promise<ScanResult> {
  const plain = categories.map(({ id, pattern }) => ({ id, pattern }))
  const computerId = routing ? await routing.computerFor({ projectId: target.projectId }) : null
  if (computerId != null && routing) {
    const live = routing
    return inPathScopeOf(db, { projectId: target.projectId }, 'testPanel.scanFiles', () =>
      live.scan(computerId, { projectPath: target.projectPath, categories: plain })
    )
  }
  return refuseNoComputer({ op: 'testPanel.scanFiles' })
}
