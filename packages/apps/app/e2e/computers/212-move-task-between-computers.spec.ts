import fs from 'node:fs'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import {
  APP_DIR,
  attachComputerToHub,
  spawnSecondHub,
  waitForHubHealth,
  withHubClient,
  type HubComputer,
  type SecondHub
} from '../fixtures/second-hub'

/**
 * Moving a task to a project that runs on ANOTHER computer of the SAME hub: its chat is
 * copied there (from the computers that held it, through the hub) and the old computer
 * lets go. No app is involved — the hub does it all — so the proof is that the chat
 * still reads, through the hub, with the first computer stopped.
 */
base.describe('move a task to a project on another computer', () => {
  base('its chat follows to the new computer; the old one is not needed any more', async () => {
    base.setTimeout(240_000)
    const store = fs.mkdtempSync(path.join(APP_DIR, 'e2e-move-computers-'))
    let hub: SecondHub | null = null
    const computers: HubComputer[] = []
    try {
      hub = await spawnSecondHub(store)
      await waitForHubHealth(hub.port)
      const rootOne = path.join(store, 'roots-one')
      const rootTwo = path.join(store, 'roots-two')
      const one = await attachComputerToHub(hub, {
        storeDir: store,
        name: 'computer-one',
        allowedRoot: rootOne
      })
      computers.push(one)
      const two = await attachComputerToHub(hub, {
        storeDir: store,
        name: 'computer-two',
        allowedRoot: rootTwo
      })
      computers.push(two)
      fs.mkdirSync(path.join(rootOne, 'project'), { recursive: true })
      fs.mkdirSync(path.join(rootTwo, 'project'), { recursive: true })

      const ids = await withHubClient(hub, async (c) => {
        const create = async (name: string, computerId: string, folder: string) =>
          (
            (await c.projects.create.mutate({
              name,
              color: name === 'On one' ? '#2563eb' : '#16a34a',
              path: folder,
              computerId
            })) as { id: string }
          ).id
        const projectOne = await create('On one', one.computerId, path.join(rootOne, 'project'))
        const projectTwo = await create('On two', two.computerId, path.join(rootTwo, 'project'))
        const task = (await c.task.create.mutate({
          projectId: projectOne,
          title: 'Chat that changes computer',
          status: 'todo',
          agentId: 'claude-chat'
        })) as { id: string }
        const tab = (await c.taskTerminals.ensureMain.mutate({
          taskId: task.id,
          mode: 'claude-chat'
        })) as { id: string }
        // A conversation on computer one, as an earlier session left it.
        await c.chat.testSeedEvents.mutate({
          tabId: tab.id,
          fromSeq: 0,
          events: [
            { kind: 'user-message', id: 'u1', text: 'asked on computer one' },
            { kind: 'assistant-text', messageId: 'm1', text: 'answered on computer one' }
          ]
        })
        return { projectOne, projectTwo, taskId: task.id, tabId: tab.id }
      })

      // The move keeps the chat's session: the preview allows it across computers.
      const preview = await withHubClient(
        hub,
        async (c) =>
          (await c.task.movePreview.query({
            taskIds: [ids.taskId],
            targetProjectId: ids.projectTwo
          })) as { sessions: Array<{ tabId: string; canKeep: boolean; reason?: string }> }
      )
      expect(preview.sessions).toEqual([
        expect.objectContaining({ tabId: ids.tabId, canKeep: true })
      ])

      await withHubClient(hub, (c) =>
        c.task.moveToProject.mutate({
          taskIds: [ids.taskId],
          targetProjectId: ids.projectTwo,
          includeSubtasks: true,
          keepSessionTabIds: [ids.tabId]
        })
      )

      // Computer one goes away: the chat is read from computer two.
      await one.stop()
      await expect
        .poll(
          () =>
            withHubClient(hub!, async (c) =>
              (
                (await c.chat.testReadEvents.query({
                  tabId: ids.tabId,
                  afterSeq: -1,
                  limit: 100
                })) as Array<{ event: { kind: string } }>
              ).map((e) => e.event.kind)
            ).catch((e: Error) => [e.message]),
          { timeout: 60_000, message: 'the chat history, read with computer one stopped' }
        )
        .toEqual(['user-message', 'assistant-text'])
    } finally {
      for (const c of computers) await c.stop()
      if (hub) await hub.stop()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })

  base(
    'with no session kept, the chat stays on the old computer and the task starts fresh',
    async () => {
      base.setTimeout(240_000)
      const store = fs.mkdtempSync(path.join(APP_DIR, 'e2e-move-computers-fresh-'))
      let hub: SecondHub | null = null
      const computers: HubComputer[] = []
      try {
        hub = await spawnSecondHub(store)
        await waitForHubHealth(hub.port)
        const rootOne = path.join(store, 'roots-one')
        const rootTwo = path.join(store, 'roots-two')
        const one = await attachComputerToHub(hub, {
          storeDir: store,
          name: 'computer-one',
          allowedRoot: rootOne
        })
        computers.push(one)
        const two = await attachComputerToHub(hub, {
          storeDir: store,
          name: 'computer-two',
          allowedRoot: rootTwo
        })
        computers.push(two)
        fs.mkdirSync(path.join(rootOne, 'project'), { recursive: true })
        fs.mkdirSync(path.join(rootTwo, 'project'), { recursive: true })
        const ids = await withHubClient(hub, async (c) => {
          const create = async (name: string, computerId: string, folder: string) =>
            (
              (await c.projects.create.mutate({
                name,
                color: name === 'On one' ? '#2563eb' : '#16a34a',
                path: folder,
                computerId
              })) as { id: string }
            ).id
          const projectOne = await create('On one', one.computerId, path.join(rootOne, 'project'))
          const projectTwo = await create('On two', two.computerId, path.join(rootTwo, 'project'))
          const task = (await c.task.create.mutate({
            projectId: projectOne,
            title: 'Chat that stays',
            status: 'todo',
            agentId: 'claude-chat'
          })) as { id: string }
          const tab = (await c.taskTerminals.ensureMain.mutate({
            taskId: task.id,
            mode: 'claude-chat'
          })) as { id: string }
          await c.chat.testSeedEvents.mutate({
            tabId: tab.id,
            fromSeq: 0,
            events: [{ kind: 'user-message', id: 'u1', text: 'private to computer one' }]
          })
          return { projectTwo, taskId: task.id, tabId: tab.id }
        })

        await withHubClient(hub, (c) =>
          c.task.moveToProject.mutate({
            taskIds: [ids.taskId],
            targetProjectId: ids.projectTwo,
            includeSubtasks: true,
            keepSessionTabIds: []
          })
        )
        // Nothing was copied to computer two: with computer one gone, the old chat cannot be read.
        await one.stop()
        const events = await withHubClient(
          hub,
          async (c) =>
            (
              (await c.chat.testReadEvents.query({
                tabId: ids.tabId,
                afterSeq: -1,
                limit: 100
              })) as unknown[]
            ).length
        ).catch((e: Error) => e.message)
        expect(events).not.toBe(1)
      } finally {
        for (const c of computers) await c.stop()
        if (hub) await hub.stop()
        fs.rmSync(store, { recursive: true, force: true })
      }
    }
  )
})
