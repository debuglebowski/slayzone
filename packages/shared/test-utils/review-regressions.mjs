#!/usr/bin/env node
/**
 * THE review-regression suite of feat/move-to-computer: every reproduction the
 * pre-merge reviewers reported, in rounds 1–6, and where it is tested. One finding,
 * one entry; a finding is closed only while every file it names passes.
 *
 *   pnpm test:review-regressions          run every entry's files (each in the lane
 *                                         and runner run-all.sh registers it with)
 *   node …/review-regressions.mjs --list  print the files, one per line
 *
 * Round 6 kept the new reproductions in one file per area (`review-regressions*.test.ts`:
 * computer, hub owner check, terminal relay); the earlier rounds' live where their
 * fixes did, named here. A finding the reviewers accepted as open (hardening, or a
 * follow-up) is listed under OPEN with the reason, not silently dropped.
 *
 * Reviews: round 1 ac5ca1a5, round 2 6cd61986, round 3 5cecc85d, round 4 30965427,
 * round 5 826655dd, round 6 cfbc0854 (slay task artifacts).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const P = 'packages/'
const computer = `${P}apps/computer/src/`
const hub = `${P}apps/hub/src/`
const lifecycle = `${P}domains/processes/src/server/process-routed-lifecycle.test.ts`
const jail = [`${computer}path-jail.test.ts`, `${computer}handlers/jail-escapes.test.ts`]
const pathTarget = `${P}domains/worktrees/src/server/git-op-path-target.test.ts`
const agreement = `${hub}path-owner-agreement.test.ts`
const ownerBoundary = `${hub}git-op-owner-boundary.test.ts`
const authorizer = `${hub}computer-request-authorizer.test.ts`
const gatewayTest = `${P}domains/computer-transport/src/server/hub-gateway.test.ts`
const execProxies = `${P}domains/computer-transport/src/server/exec-proxies.test.ts`
const computerPath = `${P}shared/platform/src/computer-path.test.ts`
const usageRouting = `${P}domains/usage-analytics/src/server/usage-routing.test.ts`
const catchUpMerge = `${P}domains/terminal/src/client/catch-up-merge.test.ts`
const rrComputer = `${computer}review-regressions.test.ts`
const rrOwner = `${hub}review-regressions-owner.test.ts`
const rrRelay = `${P}domains/terminal/src/server/runtime/review-regressions-relay.test.ts`

/** @type {Array<{ round: number, id: string, what: string, files: string[] }>} */
export const REGRESSIONS = [
  // ── round 1 ──
  {
    round: 1,
    id: 'H1',
    what: 'stop/restart waits for the tree to die, then SIGKILL',
    files: [`${computer}handlers/proc.test.ts`, lifecycle]
  },
  {
    round: 1,
    id: 'H2',
    what: 'git ops and exec.run carry timeouts above the gateway default',
    files: [`${P}domains/worktrees/src/server/git-op-timeouts.test.ts`]
  },
  { round: 1, id: 'H3', what: 'usage parse cursors re-keyed per computer', files: [usageRouting] },
  {
    round: 1,
    id: 'H4',
    what: "a git op's target is owner-checked",
    files: [`${P}apps/api/src/owner-policy.test.ts`]
  },
  {
    round: 1,
    id: 'M1',
    what: 'every computer-backed view refetches on connect',
    files: [`${P}apps/app/src/renderer/src/app-shell/computer-connect-refetch.test.ts`]
  },
  {
    round: 1,
    id: 'M2',
    what: 'subscriptions refused at boot restart on connect',
    files: [`${P}shared/transport/src/client/computerConnect.test.tsx`]
  },
  {
    round: 1,
    id: 'M4',
    what: 'a relay change while the spawn is queued is kept',
    files: [`${computer}handlers/pty.test.ts`]
  },
  {
    round: 1,
    id: 'M5',
    what: 'legacy chat readers read the new tables',
    files: [
      `${P}domains/chat-runtime/src/server/legacy-session-authority.test.ts`,
      `${P}domains/chat-runtime/src/server/hub-availability.test.ts`,
      `${P}domains/terminal/src/server/runtime/chat-data-ops.test.ts`,
      `${hub}review-migration-state.test.ts`
    ]
  },
  {
    round: 1,
    id: 'M6b',
    what: 'a same-epoch reconnect keeps adopted runs',
    files: [lifecycle, execProxies]
  },
  {
    round: 1,
    id: 'M7',
    what: 'catch-up writes each chunk once, in seq order',
    files: [catchUpMerge]
  },
  {
    round: 1,
    id: 'M8',
    what: 'git watchers end with their hub connection',
    files: [
      `${computer}handlers/git-watch.test.ts`,
      `${P}domains/worktrees/src/server/git-watch-routing.test.ts`
    ]
  },
  {
    round: 1,
    id: 'low: dangling link write',
    what: 'a dangling link out is refused for a write',
    files: jail
  },
  {
    round: 1,
    id: 'low: routing separators',
    what: 'Windows separators and one folder on two computers route right',
    files: [pathTarget]
  },
  // ── round 2 ──
  {
    round: 2,
    id: 'R1',
    what: 'usage.collect is paged under the message limit',
    files: [`${computer}handlers/usage-collect.test.ts`, usageRouting]
  },
  {
    round: 2,
    id: 'R2',
    what: 'an old host answering -32001 reads as "update pending"',
    files: [gatewayTest, `${computer}main.test.ts`]
  },
  {
    round: 2,
    id: 'R3',
    what: 'stop without pgrep still SIGKILLs a stubborn child',
    files: [`${computer}terminate-tree.test.ts`]
  },
  {
    round: 2,
    id: 'R4',
    what: 'reconnect sweep keeps runs adopted after a hub restart',
    files: [lifecycle, execProxies]
  },
  {
    round: 2,
    id: 'R5',
    what: 'restart never starts while the old tree survives',
    files: [lifecycle]
  },
  {
    round: 2,
    id: 'R6',
    what: 'auto-worktree steps carry minutes-long timeouts',
    files: [execProxies]
  },
  {
    round: 2,
    id: 'R7',
    what: "the hub's own background git reads still reach the computer",
    files: [ownerBoundary, authorizer]
  },
  { round: 2, id: 'R8', what: 'catch-up never duplicates or reorders', files: [catchUpMerge] },
  // ── round 3 ──
  {
    round: 3,
    id: 'F1',
    what: 'a cancelled catch-up keeps its held chunks',
    files: [`${P}domains/terminal/src/client/catch-up-controller.test.ts`]
  },
  {
    round: 3,
    id: 'F2',
    what: "a `..` path never reaches another user's computer",
    files: [ownerBoundary, pathTarget]
  },
  {
    round: 3,
    id: 'F3',
    what: 'links through links and `..` after a link are judged by the real parent',
    files: jail
  },
  {
    round: 3,
    id: 'F4',
    what: 'the real computer answer to an unknown method names its version',
    files: [gatewayTest]
  },
  {
    round: 3,
    id: 'F5',
    what: 'Start after old-run-survives ends the survivor first',
    files: [lifecycle]
  },
  {
    round: 3,
    id: 'F6',
    what: 'Windows npm shims for the conflict-AI argv',
    files: [`${computer}handlers/resolve-command.test.ts`]
  },
  // ── round 4 ──
  {
    round: 4,
    id: 'G1',
    what: 'root/miss/../l with l dangling out: no write outside, no crash',
    files: jail
  },
  {
    round: 4,
    id: 'G2',
    what: 'every hub→computer method is owner-checked; POSIX `\\` and UNC forms',
    files: [authorizer, gatewayTest, agreement, pathTarget, computerPath, ...jail]
  },
  {
    round: 4,
    id: 'G3',
    what: "Start/Stop while the old run's computer is offline",
    files: [
      lifecycle,
      `${P}domains/task/src/client/ProcessesPanel.test.tsx`,
      `${P}apps/api/src/routers/computers.test.ts`
    ]
  },
  {
    round: 4,
    id: 'G4',
    what: 'copy-in onto a dangling link writes a new file in the root',
    files: jail
  },
  {
    round: 4,
    id: 'G5',
    what: 'stored Windows paths in either separator still match',
    files: [pathTarget, agreement]
  },
  // ── round 5 ──
  {
    round: 5,
    id: 'K1/K2',
    what: '`//`, case and Unicode variants are one path (hub key and jail)',
    files: [`${P}apps/api/src/access.test.ts`, agreement, computerPath, ...jail]
  },
  {
    round: 5,
    id: 'K3',
    what: 'copying a big node_modules never starves the event loop',
    files: [`${computer}handlers/copy-ignored-files.test.ts`]
  },
  {
    round: 5,
    id: 'K4',
    what: "main's reply mirror runs on the computer",
    files: [`${computer}pty-signals.test.ts`]
  },
  {
    round: 5,
    id: 'K5/K6/K9',
    what: 'no Start-anyway override; stats tick as the hub; removed computers free their runs',
    files: [
      lifecycle,
      `${P}domains/computers/src/server/store.test.ts`,
      `${P}apps/api/src/routers/computers.test.ts`
    ]
  },
  {
    round: 5,
    id: 'K7',
    what: 'subscription bodies run as their caller',
    files: [`${P}shared/trpc-server/src/subscription-security-context.test.ts`]
  },
  {
    round: 5,
    id: 'K8',
    what: 'readDir and searchFiles through links stay in the jail',
    files: jail
  },
  // ── round 6 ──
  {
    round: 6,
    id: 'L1',
    what: 'the built computer bundle starts on plain Node',
    files: [rrComputer, `${P}domains/terminal/src/server/graphemes-addon-load.test.ts`]
  },
  {
    round: 6,
    id: 'L2',
    what: "one user's subscription never stops another's live output",
    files: [rrRelay]
  },
  {
    round: 6,
    id: 'L3',
    what: "case folding is the computer's, never the hub disk's",
    files: [rrOwner]
  },
  {
    round: 6,
    id: 'L4',
    what: 'a disabled computer refuses exec.run and new worktrees',
    files: [rrOwner]
  },
  {
    round: 6,
    id: 'L5',
    what: 'copying ignored files keeps links in link-only folders',
    files: [rrComputer]
  },
  {
    round: 6,
    id: 'L6',
    what: '/.vol, firmlink and Windows aliases resolve before the owner check',
    files: [rrOwner]
  }
]

/** Reported, and deliberately not (yet) closed — with the reviewers' own verdict. */
export const OPEN = [
  {
    round: 1,
    id: 'M3',
    why: 'refs without `--`: downgraded to hardening in round 2 (only the owner, who has a shell, reaches these calls)'
  },
  {
    round: 1,
    id: 'M6a',
    why: 'a project bound to an offline computer: partly covered by process-routed-lifecycle ("no computer")'
  },
  { round: 6, id: 'L7-L10', why: 'low items of round 6, not in this round' }
]

export function regressionFiles() {
  return [...new Set(REGRESSIONS.flatMap((r) => r.files))].sort()
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = regressionFiles()
  const missing = files.filter((f) => !existsSync(join(ROOT, f)))
  if (missing.length > 0) {
    console.error(`review-regressions: missing test files:\n  ${missing.join('\n  ')}`)
    process.exit(2)
  }
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'))
    process.exit(0)
  }
  const dir = mkdtempSync(join(tmpdir(), 'slz-review-regressions-'))
  const list = join(dir, 'files.txt')
  writeFileSync(list, `${files.join('\n')}\n`)
  console.log(`review regressions: ${REGRESSIONS.length} findings, ${files.length} test files`)
  const run = spawnSync('bash', [join(ROOT, 'packages/shared/test-utils/run-all.sh')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SLZ_UNIT_ONLY: list }
  })
  rmSync(dir, { recursive: true, force: true })
  process.exit(run.status ?? 1)
}
