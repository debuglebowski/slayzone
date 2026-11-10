import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'

async function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'artifact-rpc-second-review-'))
  const pc = createFixtureChatRuntime({
    stateDir: dir,
    hubScope: 'audit',
    computerId: () => 'pc',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: 'ws://audit/computers',
        name: 'audit',
        allowedRoots: [dir],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  })
  await pc.request({
    kind: 'bootstrap',
    value: {
      identity: { id: 'store', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    }
  })
  const route = { id: 'store', epoch: 1 }
  const invoke = (method: string, args: unknown[], operationId?: string) =>
    pc.request(
      JSON.parse(
        JSON.stringify({
          kind: 'artifact.invoke',
          value: { route, method, args, ...(operationId ? { operationId } : {}) }
        })
      )
    )
  return {
    invoke,
    close: async () => {
      await pc.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('concurrent duplicate artifact uploads return one durable result and create one file', async () => {
  const f = await fixture()
  try {
    const args = [
      { taskId: 'task', title: 'once.txt', data: Buffer.from('one upload').toString('base64') }
    ]
    const results = await Promise.all([
      f.invoke('uploadArtifactBlob', args, 'same-upload'),
      f.invoke('uploadArtifactBlob', args, 'same-upload')
    ])
    const listed = (await f.invoke('listArtifactsByTask', ['task'])) as Array<{ id: string }>
    expect(listed).toHaveLength(1)
    expect(results[1]).toEqual(results[0])
  } finally {
    await f.close()
  }
})

test('sequential duplicate upload is a passing control', async () => {
  const f = await fixture()
  try {
    const args = [
      { taskId: 'task', title: 'once.txt', data: Buffer.from('one upload').toString('base64') }
    ]
    const first = await f.invoke('uploadArtifactBlob', args, 'same-upload')
    expect(await f.invoke('uploadArtifactBlob', args, 'same-upload')).toEqual(first)
    expect(await f.invoke('listArtifactsByTask', ['task'])).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('concurrent operation-id reuse with different input remains rejected', async () => {
  const f = await fixture()
  try {
    const request = (text: string) =>
      f.invoke(
        'uploadArtifactBlob',
        [{ taskId: 'task', title: 'once.txt', data: Buffer.from(text).toString('base64') }],
        'same-operation'
      )
    const results = await Promise.allSettled([request('first'), request('different')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.message).toMatch(/reused|different/i)
    expect(await f.invoke('listArtifactsByTask', ['task'])).toHaveLength(1)
  } finally {
    await f.close()
  }
})
