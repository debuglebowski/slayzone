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
 * round 5 826655dd, round 6 cfbc0854; round 7 N1: task 5d69cafd, n1-hub-path-reads-report.html
 * (slay task artifacts).
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
    files: [
      `${P}domains/worktrees/src/server/git-op-timeouts.test.ts`,
      `${hub}computer-exec-run.test.ts`
    ]
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
  {
    round: 2,
    id: 'R9',
    what: 'lazy node-pty, bounded signal strings, the boot-window watch retry, conflict-AI argv',
    files: [
      `${computer}node-pty-lazy.test.ts`,
      `${computer}native-probe.test.ts`,
      `${P}domains/computer-transport/src/shared/frames-bounds.test.ts`,
      `${P}domains/worktrees/src/client/git-diff-store.test.ts`,
      `${P}domains/worktrees/src/server/merge-ai-routing.test.ts`,
      `${hub}computer-probes.test.ts`
    ]
  },
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
    what: 'Windows npm shims and stdin for the conflict-AI argv',
    files: [`${computer}handlers/resolve-command.test.ts`, `${computer}handlers/exec-run.test.ts`]
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
    what: "migration versions unique and increasing; a DB at main's v194 reaches latest",
    files: [`${P}shared/db-migrations/src/review-regressions-migrations.test.ts`]
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
  {
    round: 5,
    id: 'K4 merge',
    what: "main's reply mirror, merged in K4, runs on the computer",
    files: [`${computer}pty-signals.test.ts`]
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
    files: [`${hub}review-regressions-l3-folding-hub.test.ts`, rrOwner]
  },
  {
    round: 6,
    id: 'L4',
    what: 'a disabled computer refuses exec.run and new worktrees',
    files: [`${hub}computer-disabled-gateway.test.ts`, rrOwner]
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
  },
  // ── round 7 ──
  {
    round: 7,
    id: 'N2',
    what: "K2's worst vector: an agentConfig.fs rename onto COMPUTER.CONFIG.JSON",
    files: [`${computer}handlers/jail-escapes.test.ts`]
  },
  {
    round: 7,
    id: 'N1',
    what: 'hub-disk path procedures need a root the caller owns; /dev /proc /sys /.vol refused',
    files: [
      `${hub}hub-local-path-reads.test.ts`,
      `${P}apps/api/src/routers/hub-local-paths.test.ts`,
      `${P}apps/api/src/routers/upload-sources.test.ts`,
      `${P}apps/api/src/access.test.ts`
    ]
  },
  {
    round: 7,
    id: 'N3',
    what: 'a ws subscription stopped during its middlewares never subscribes',
    files: [`${P}apps/api/src/ws-subscription-stop-race.test.ts`]
  },
  {
    round: 7,
    id: 'N5',
    what: "tree access checks reuse each root's ancestry (no stat storm per check)",
    files: [`${P}apps/api/src/access-tree-cost.test.ts`]
  },
  {
    round: 7,
    id: 'N6',
    what: 'git routing: exact case first, else one case-insensitive candidate',
    files: [rrOwner]
  },
  {
    round: 7,
    id: 'N7',
    what: 'pty.relay sent once on reconnect; an old computer without it is asked once',
    files: [
      `${P}domains/terminal/src/server/runtime/review-regressions-relay.test.ts`,
      `${P}domains/computer-transport/src/server/exec-proxies.test.ts`
    ]
  },
  {
    round: 7,
    id: 'N4',
    what: "a path tie between owners is broken by the request's computer, else denied and audited",
    files: [rrOwner]
  },
  // ── round 8 ──
  {
    round: 8,
    id: 'P4',
    what: 'the K2 rename repro protects the file as production does (red before K2)',
    files: [`${P}apps/computer/src/handlers/jail-escapes.test.ts`]
  },
  {
    round: 8,
    id: 'P3',
    what: 'a ws stop in the same tick as its subscribe (and out of order) never leaks',
    files: [`${P}apps/api/src/ws-subscription-stop-race.test.ts`]
  },
  {
    round: 8,
    id: 'P2',
    what: "naming a computer never wins a path tie on the hub's disk",
    files: [`${P}apps/api/src/routers/review-regressions-hub-disk.test.ts`]
  },
  {
    round: 8,
    id: 'P1',
    what: 'no procedure, REST route or MCP tool reads a hub-disk path the caller may not access',
    files: [`${P}apps/api/src/hub-disk-canary.test.ts`]
  },
  // ── round 9 ──
  {
    round: 9,
    id: 'Q1',
    what: "a remote computer's folders never own anything on the hub's disk",
    files: [
      `${P}apps/api/src/routers/review-regressions-hub-disk.test.ts`,
      `${P}apps/api/src/access.test.ts`
    ]
  },
  {
    round: 9,
    id: 'Q2',
    what: "a legacy project path does not lock its owner out on the owner's computer",
    files: [`${P}apps/hub/src/review-regressions-owner.test.ts`]
  },
  {
    round: 9,
    id: 'Q3',
    what: 'the hub-disk canary seeds what users plant (computer folders, worktrees) and every input shape',
    files: [`${P}apps/api/src/hub-disk-canary.test.ts`]
  },
  {
    round: 9,
    id: 'Q4',
    what: 'git.watchStart answers once the watch is live; a change right after it is never missed',
    files: [`${P}apps/computer/src/handlers/git-watch.test.ts`]
  },
  // ── round 10 ──
  {
    round: 10,
    id: 'R10-1',
    what: "a login hub never writes a project's legacy path; it refuses to boot without a folder host (B18)",
    files: [
      `${P}apps/api/src/routers/review-regressions-hub-disk.test.ts`,
      `${P}apps/hub/src/boot-rules.test.ts`,
      `${P}apps/api/src/hub-disk-canary.test.ts`
    ]
  },
  {
    round: 10,
    id: 'R10-3',
    what: 'a repo whose .git is a symlink starts watching at once (real gitdir watched)',
    files: [`${P}domains/worktrees/src/server/git-watcher.test.ts`]
  },
  {
    round: 10,
    id: 'R10-2',
    what: 'past the readiness cap a watch keeps confirming and rescans once live: no change lost',
    files: [
      `${P}domains/worktrees/src/server/git-watcher.test.ts`,
      `${computer}handlers/git-watch.test.ts`
    ]
  },
  {
    round: 11,
    id: 'H1-final',
    what: 'cron catch-up waits for the computer and runs once when it connects',
    files: [`${P}domains/automations/src/server/engine-catchup.test.ts`]
  },
  // ── round 11 ──
  {
    round: 11,
    id: 'M4-final',
    what: 'exec.run decodes output as one stream (no U+FFFD at chunk boundaries)',
    files: [`${P}apps/computer/src/handlers/exec-run.test.ts`]
  },
  {
    round: 11,
    id: 'M1-final',
    what: 'an exit error before any output (seq -1) reaches the hub',
    files: [`${P}domains/computer-transport/src/server/exec-proxies.test.ts`]
  },
  {
    round: 11,
    id: 'M2-final',
    what: "a recovery shell continues the session's seq numbering (no blank terminal)",
    files: [
      `${P}apps/computer/src/handlers/pty.test.ts`,
      `${P}domains/computer-transport/src/server/exec-proxies.test.ts`
    ]
  },
  {
    round: 11,
    id: 'M3-final',
    what: 'a panel joining a git watch start that fails is told; a refused start is never stopped',
    files: [
      `${P}domains/worktrees/src/server/git-watch-routing.test.ts`,
      `${P}domains/worktrees/src/client/git-diff-store.test.ts`
    ]
  },
  {
    round: 11,
    id: 'M7-final',
    what: "a folder copy never copies the computer's protected state",
    files: [`${P}apps/computer/src/handlers/jail-escapes.test.ts`]
  },
  {
    round: 11,
    id: 'M9-rest',
    what: 'REST auth decides on the path as express routes it (case, slashes, encoding); fails closed',
    files: [`${P}apps/hub/src/rest-auth.test.ts`]
  },
  {
    round: 11,
    id: 'M8-final',
    what: 'owner resolution: one contender owns; depth by matched position; stale legacy paths no hub-disk root',
    files: [`${P}apps/hub/src/review-regressions-owner.test.ts`, `${P}apps/api/src/access.test.ts`]
  },
  {
    round: 11,
    id: 'M9-roots',
    what: "roots on another computer never decide a named computer's path; / is no root",
    files: [`${P}apps/hub/src/review-regressions-owner.test.ts`]
  },
  {
    round: 11,
    id: 'M6-final',
    what: 'a custom worktree base and an automation folder are registered as local-computer roots',
    files: [`${P}apps/hub/src/computer-project-sync.test.ts`]
  },
  {
    round: 11,
    id: 'M5-final',
    what: 'process groups a crashed computer left running are ended by the next host',
    files: [`${P}apps/computer/src/handlers/proc.test.ts`]
  },
  // ── round 12 ──
  {
    round: 12,
    id: 'R2-1',
    what: 'the orphan reaper kills only groups it can prove are its own (boot id, live-member proof), and a clean quit leaves no entry',
    files: [`${P}apps/computer/src/proc-group-ledger.test.ts`]
  },
  {
    round: 12,
    id: 'M6-low',
    what: 'roots registered for work folders are removed when no worktree base or automation needs them',
    files: [`${P}apps/hub/src/computer-project-sync.test.ts`]
  },
  // ── round 13 ──
  {
    round: 13,
    id: 'R3-1',
    what: 'a work-folder root stays while a local task worktree still lives under it (worktree base changed)',
    files: [`${P}apps/hub/src/computer-project-sync.test.ts`]
  },
  {
    round: 13,
    id: 'R3-2',
    what: 'local_computer_work_roots is left out of every export and ignored on import',
    files: [`${P}apps/api/src/export-import-machine-local.test.ts`]
  },
  // ── round 14 ──
  {
    round: 14,
    id: 'R4-1',
    what: 'a soft-deleted task restored after a relaunch keeps its worktree root until purged',
    files: [`${P}apps/hub/src/computer-project-sync.test.ts`]
  },
  // ── round 15 ──
  {
    round: 15,
    id: 'R5-1',
    what: 'the Trash purge deletes a task only after its worktree is removed; no computer = keep and retry on connect; a computer gone for good never blocks',
    files: [
      `${P}domains/task/src/server/ops/startup-purge-computer.test.ts`,
      `${P}apps/hub/src/worktree-computer-state.test.ts`
    ]
  },
  // ── direct link (feat/direct-link) ──
  {
    round: 16,
    id: 'DL-canary',
    what: "the direct-link canary: no direct-router procedure (pty, chat, over WebSocket or a WebRTC data channel) touches a file on the computer's disk",
    files: [`${P}apps/computer/src/direct/direct-canary.test.ts`]
  },
  // ── post-merge QA (task 964073b0, row 5b) ──
  {
    round: 16,
    id: 'QA-5b',
    what: 'a project instructions edit saves with no project instructions item; every AI-config write lands on the computer; a refused save is shown, never swallowed',
    files: [
      `${P}domains/ai-config/src/server/ai-config-routing.test.ts`,
      `${P}domains/file-editor/src/client/useWatchedFile.test.ts`
    ]
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
