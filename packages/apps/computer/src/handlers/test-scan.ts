/**
 * `testPanel.scan`: the test panel's file scan, run on THIS computer with the same
 * scanner the hub used, the project folder jailed first.
 *
 * @module computer/handlers/test-scan
 */
import {
  HubToComputerMethods,
  testPanelScanParamsSchema
} from '@slayzone/computer-transport/shared'
import { scanTestFiles } from '@slayzone/test-panel/scanner'
import { assertPathAllowed } from '../config'
import type { HandlerContext, HubMethodTable } from './types'

export function createTestScanHandlers(ctx: HandlerContext): HubMethodTable {
  async function scan(raw: unknown): Promise<unknown> {
    const { projectPath, categories } = testPanelScanParamsSchema.parse(raw)
    assertPathAllowed(projectPath, ctx.config.allowedRoots)
    return scanTestFiles(projectPath, categories)
  }
  return { [HubToComputerMethods.testPanelScan]: scan }
}
