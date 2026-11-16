import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import {
  createChatMigration,
  createChatMigrationAttachmentReader,
  createChatOwnershipStore,
  createLegacyChatSource
} from '@slayzone/chat-runtime/server'
import type { ChatRecord } from '@slayzone/chat-runtime/shared'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'

const root = resolve(import.meta.dirname, '../../../..')
const requireHub = createRequire(join(root, 'packages/apps/hub/package.json'))
let historical: Promise<typeof createLegacyChatSource> | undefined
function releasedLegacySource() {
  return (historical ??= (async () => {
    // Real released exporter. Only stable runtime values imported from two large
    // modules are isolated; the historical serialization code stays unchanged.
    const source = execFileSync(
      'git',
      ['show', 'ed9673300:packages/domains/chat-runtime/src/server/legacy-source.ts'],
      { cwd: root, encoding: 'utf8' }
    )
    const esbuild = requireHub('esbuild') as typeof import('esbuild')
    const result = await esbuild.build({
      stdin: {
        contents: source,
        resolveDir: join(root, 'packages/domains/chat-runtime/src/server'),
        sourcefile: 'released-legacy-source.ts',
        loader: 'ts'
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
      plugins: [
        {
          name: 'stable-legacy-export-values',
          setup(build) {
            build.onResolve({ filter: /^\.\/(local-data|transfers)$/ }, (args) => ({
              path: args.path,
              namespace: 'legacy-values'
            }))
            build.onLoad({ filter: /.*/, namespace: 'legacy-values' }, (args) => ({
              contents:
                args.path === './local-data'
                  ? 'export const sessionRecordKey = (mode, id) => `session:${JSON.stringify([mode,id])}`'
                  : 'export const TRANSFER_CHUNK_BYTES = 256 * 1024',
              loader: 'js'
            }))
          }
        }
      ]
    })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(
      requireHub,
      module,
      module.exports
    )
    return (module.exports as { createLegacyChatSource: typeof createLegacyChatSource })
      .createLegacyChatSource
  })())
}

test.each([false, true])(
  'released prepared migration resumes after update with unsealed attachment=%s',
  async (unsealed) => {
    const oldSource = await releasedLegacySource()
    const h = await createTestHarness()
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'historical-chat-stage-'))
    const bytes = Buffer.from('released prepared attachment bytes')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const pc = createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'audit',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://historical/computers',
          name: 'historical',
          allowedRoots: [dir],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
    try {
      // The released exporter ran BEFORE the update, against a hub that still held
      // the session ledger, prompts and turns (v206/v207 moved them to the computer,
      // robustness plan §9): their empty tables, as that hub had them.
      h.db.exec(`CREATE TABLE task_conversations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        mode TEXT NOT NULL, tab_id TEXT, conversation_id TEXT, origin TEXT NOT NULL,
        pending_meta TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE agent_prompts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
          cli_session_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE agent_turns (id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, task_id TEXT,
          terminal_tab_id TEXT NOT NULL, snapshot_sha TEXT NOT NULL, prompt_preview TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL, head_sha_at_snap TEXT)`)
      h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
      h.db
        .prepare("INSERT INTO tasks(id,project_id,title,has_worktree) VALUES('task','p','Task',1)")
        .run()
      h.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
        )
        .run()
      const artifacts = createArtifactStore(dir)
      const file = await artifacts.uploadArtifactBlob(h.slayDb, {
        taskId: 'task',
        title: 'released.txt',
        bytes
      })
      const ref = {
        artifactId: file!.id,
        name: 'released.txt',
        kind: 'text' as const,
        mediaType: 'text/plain' as const,
        size: bytes.length,
        ...(!unsealed ? { contentHash: hash } : {})
      }
      h.db
        .prepare(
          "INSERT INTO chat_tab_state(tab_id,draft_text,draft_attachments,rev,updated_at) VALUES('tab','released draft',?,3,123)"
        )
        .run(JSON.stringify([ref]))
      const ownership = createChatOwnershipStore(h.slayDb)
      await ownership.register({
        id: 'history',
        taskId: 'task',
        tabId: 'tab',
        mode: 'claude-chat',
        epoch: 1,
        computerId: null
      })
      const owner = await ownership.beginMigration('history', {
        expectedComputerId: null,
        expectedEpoch: 1,
        migrationId: 'released-stage',
        destinationComputerId: 'pc'
      })
      const request = (_id: string, body: unknown) => pc.request(body)
      const options: Parameters<typeof createLegacyChatSource>[0] = {
        db: h.slayDb,
        quiesce: async () => {},
        bootstrap: async (owner) => ({
          identity: {
            id: owner.id,
            taskId: owner.taskId,
            tabId: owner.tabId,
            mode: owner.mode,
            epoch: owner.epoch + 1
          },
          projectId: 'p',
          cwd: dir,
          revision: 0,
          providerConfig: {},
          defaultFlags: null,
          env: {}
        }),
        freezeMetadata: async (owner, migrationId, candidate) =>
          request('pc', {
            kind: 'migration.checkpoint',
            identity: {
              id: owner.id,
              taskId: owner.taskId,
              tabId: owner.tabId,
              mode: owner.mode,
              epoch: owner.epoch
            },
            migrationId,
            ...(candidate ? { candidate } : {})
          }) as Promise<ChatRecord[] | null>,
        readAttachment: async () => bytes,
        readPinnedAttachment: createChatMigrationAttachmentReader(h.slayDb, dir)
      }
      const transfer = await oldSource(options).open(owner, 'released-stage')
      const start = (await request('pc', {
        kind: 'transfer.begin',
        manifest: transfer.manifest
      })) as { id: string; offset: number }
      let offset = start.offset
      for await (const chunk of transfer.chunks(offset)) {
        await request('pc', {
          kind: 'transfer.chunk',
          id: start.id,
          offset,
          data: Buffer.from(chunk).toString('base64')
        })
        offset += chunk.length
      }
      await request('pc', { kind: 'transfer.finish', id: start.id })
      expect(h.db.prepare('SELECT count(*) AS n FROM artifact_blob_pins').get()).toEqual({ n: 0 })
      const checkpoint = await options.freezeMetadata!(owner, 'released-stage')
      expect(checkpoint?.some((r) => r.id === 'legacy-attachment-manifest')).toBe(false)
      const prepared = (await request('pc', { kind: 'migration.prepared', id: 'history' })) as {
        hash: string
      }
      expect(prepared.hash).toBe(transfer.manifest.hash)

      const source = createLegacyChatSource(options)
      await expect(
        createChatMigration({ ownership, source, request }).ensure('history', 'pc')
      ).resolves.toMatchObject({ state: 'active', cleanupPending: false, epoch: 2 })
      expect(
        await request('pc', {
          kind: 'attachment.read',
          route: { id: 'history', epoch: 2 },
          ref: { ...ref, contentHash: hash }
        })
      ).toEqual({ data: bytes.toString('base64') })
      expect(h.db.prepare("SELECT 1 FROM chat_tab_state WHERE tab_id='tab'").get()).toBeUndefined()
    } finally {
      await pc.close()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
