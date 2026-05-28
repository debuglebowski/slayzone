import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { CreateTagInput, UpdateTagInput } from '@slayzone/tags/shared'
import {
  listAllTags,
  createTag,
  updateTag,
  deleteTag,
  reorderTags,
  getTagsForTask,
  getAllTaskTagIds,
  setTagsForTask
} from '@slayzone/tags/server'

export function registerTagHandlers(ipcMain: IpcMain, db: Database): void {
  // Tags CRUD
  ipcMain.handle('db:tags:getAll', () => listAllTags(db))

  ipcMain.handle('db:tags:create', (_, data: CreateTagInput) => createTag(db, data))

  ipcMain.handle('db:tags:update', (_, data: UpdateTagInput) => updateTag(db, data))

  ipcMain.handle('db:tags:delete', (_, id: string) => deleteTag(db, id))

  ipcMain.handle('db:tags:reorder', (_, tagIds: string[]) => {
    reorderTags(db, tagIds)
  })

  // Task-Tag associations
  ipcMain.handle('db:taskTags:getForTask', (_, taskId: string) => getTagsForTask(db, taskId))

  ipcMain.handle('db:taskTags:getAll', () => getAllTaskTagIds(db))

  ipcMain.handle('db:taskTags:setForTask', (_, taskId: string, tagIds: string[]) => {
    setTagsForTask(db, taskId, tagIds)
    ipcMain.emit('db:taskTags:setForTask:done', null, taskId, tagIds)
  })
}
