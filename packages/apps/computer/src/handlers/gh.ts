/**
 * Run `gh` on the computer.
 *
 * `gh` authenticates as whoever owns the machine it runs on. Running it on the
 * hub meant the PR panel spoke as the HUB while the agent pushed as the COMPUTER —
 * two identities for one repository, and only one of them had credentials for it.
 * So it moves here, where the checkout and the credentials already are.
 *
 * One generic exec, not one handler per subcommand. The hub keeps its eleven
 * typed functions (`listOpenPrs`, `createPr`, `getPrComments`, …) and all their
 * JSON parsing; only the process crosses over. Eleven frames would be eleven
 * chances for the wire drift this contract has already paid for four times.
 *
 * argv, never a shell string. A PR title or comment body is arbitrary user text,
 * and routing it through a shell would make quoting a security boundary.
 *
 * @module computer/handlers/gh
 */

import { execFile } from 'node:child_process'
import {
  ghExecParamsSchema,
  HubToComputerMethods,
  type GhExecResult
} from '@slayzone/computer-transport/shared'
import { assertPathAllowed } from '../config'
import type { HandlerContext, HubMethodTable } from './types'

const DEFAULT_TIMEOUT_MS = 30_000
/** gh can emit a large diff; the PR-diff caller reads whole patches. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export function createGhHandlers(ctx: HandlerContext): HubMethodTable {
  // `async` deliberately: validation and the jail check must surface as a
  // REJECTION, not a synchronous throw from a Promise-returning function. Callers
  // await this, and a function that sometimes throws before returning its promise
  // is a footgun for every one of them.
  async function ghExec(rawParams: unknown): Promise<GhExecResult> {
    const params = ghExecParamsSchema.parse(rawParams)
    const cwd = assertPathAllowed(params.cwd, ctx.config.allowedRoots)

    return new Promise((resolve) => {
      const child = execFile(
        'gh',
        params.args,
        {
          cwd,
          timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          // No env overlay: gh must see this machine's own `GH_*`/`GITHUB_TOKEN`
          // and credential helpers. Injecting anything here would be SlayZone
          // taking custody of credentials it deliberately does not hold.
          env: process.env
        },
        (err, stdout, stderr) => {
          // Resolve on failure rather than reject: every caller above already
          // branches on a non-zero status, and gh uses exit codes for ordinary
          // answers ("no pull requests found") as well as real errors.
          const status =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code: number }).code as number)
              : err
                ? null
                : 0
          resolve({ status, stdout: stdout ?? '', stderr: stderr ?? '' })
        }
      )
      // A PR body can be long enough to be awkward as an argv entry; callers pass
      // it on stdin and gh reads `--body-file -`.
      if (params.stdin !== undefined) {
        child.stdin?.end(params.stdin)
      }
    })
  }

  return { [HubToComputerMethods.ghExec]: ghExec }
}
