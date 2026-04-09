import { useState, useEffect, useCallback, useMemo } from 'react'
import type { TaskAsset, RenderMode, CreateAssetInput, UpdateAssetInput, AssetFolder, UpdateAssetFolderInput } from '@slayzone/task/shared'
import { track } from '@slayzone/telemetry/client'

export interface UseAssetsReturn {
  assets: TaskAsset[]
  folders: AssetFolder[]
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  // Asset ops
  createAsset: (params: { title: string; folderId?: string | null; renderMode?: RenderMode; content?: string; language?: string | null }) => Promise<TaskAsset | null>
  updateAsset: (data: UpdateAssetInput) => Promise<void>
  deleteAsset: (id: string) => Promise<void>
  renameAsset: (id: string, newTitle: string) => Promise<void>
  moveAssetToFolder: (assetId: string, folderId: string | null) => Promise<void>
  readContent: (id: string) => Promise<string | null>
  saveContent: (id: string, content: string) => Promise<void>
  uploadAsset: (sourcePath: string, title?: string) => Promise<TaskAsset | null>
  uploadDir: (dirPath: string, parentFolderId?: string | null) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  downloadFile: (id: string) => Promise<boolean>
  downloadFolder: (id: string) => Promise<boolean>
  // Folder ops
  createFolder: (params: { name: string; parentId?: string | null }) => Promise<AssetFolder | null>
  updateFolder: (data: UpdateAssetFolderInput) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  renameFolder: (id: string, newName: string) => Promise<void>
  // Path helpers
  getAssetPath: (asset: TaskAsset) => string
  pathToFolderId: Map<string, string>
  folderPathMap: Map<string, string>
}

export function useAssets(taskId: string | null | undefined, initialSelectedId?: string | null): UseAssetsReturn {
  const [assets, setAssets] = useState<TaskAsset[]>([])
  const [folders, setFolders] = useState<AssetFolder[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null)

  // Re-sync selection when switching tasks
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSelectedId(initialSelectedId ?? null) }, [taskId])

  // Fetch assets + folders on mount and external changes
  useEffect(() => {
    if (!taskId) return
    const load = (): void => {
      window.api.assets.getByTask(taskId).then(setAssets).catch(() => {})
      window.api.assetFolders.getByTask(taskId).then(setFolders).catch(() => {})
    }
    load()
    const cleanup = window.api?.app?.onTasksChanged?.(load)
    return () => { cleanup?.() }
  }, [taskId])

  // Build folder path lookup: folderId -> slash-separated path
  const folderPathMap = useMemo(() => {
    const map = new Map<string, string>()
    const byId = new Map(folders.map(f => [f.id, f]))
    function resolve(id: string): string {
      if (map.has(id)) return map.get(id)!
      const f = byId.get(id)
      if (!f) return ''
      const path = f.parent_id ? `${resolve(f.parent_id)}/${f.name}` : f.name
      map.set(id, path)
      return path
    }
    for (const f of folders) resolve(f.id)
    return map
  }, [folders])

  // Reverse lookup: path string -> folderId
  const pathToFolderId = useMemo(() => {
    const map = new Map<string, string>()
    for (const [id, path] of folderPathMap) map.set(path, id)
    return map
  }, [folderPathMap])

  const getAssetPath = useCallback((asset: TaskAsset): string => {
    if (!asset.folder_id) return asset.title
    const folderPath = folderPathMap.get(asset.folder_id)
    return folderPath ? `${folderPath}/${asset.title}` : asset.title
  }, [folderPathMap])

  // --- Asset CRUD ---

  const createAsset = useCallback(async (params: { title: string; folderId?: string | null; renderMode?: RenderMode; content?: string; language?: string | null }): Promise<TaskAsset | null> => {
    if (!taskId) return null
    const data: CreateAssetInput = { taskId, ...params }
    const asset = await window.api.assets.create(data)
    if (asset) {
      setAssets(prev => [...prev, asset])
      setSelectedId(asset.id)
      track('asset_created')
    }
    return asset
  }, [taskId])

  const updateAsset = useCallback(async (data: UpdateAssetInput): Promise<void> => {
    const updated = await window.api.assets.update(data)
    if (updated) {
      setAssets(prev => prev.map(a => a.id === data.id ? updated : a))
    }
  }, [])

  const deleteAsset = useCallback(async (id: string): Promise<void> => {
    await window.api.assets.delete(id)
    setAssets(prev => prev.filter(a => a.id !== id))
    setSelectedId(prev => prev === id ? null : prev)
    track('asset_deleted')
  }, [])

  const renameAsset = useCallback(async (id: string, newTitle: string): Promise<void> => {
    const updated = await window.api.assets.update({ id, title: newTitle })
    if (updated) {
      setAssets(prev => prev.map(a => a.id === id ? updated : a))
    }
  }, [])

  const moveAssetToFolder = useCallback(async (assetId: string, folderId: string | null): Promise<void> => {
    const updated = await window.api.assets.update({ id: assetId, folderId })
    if (updated) {
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a))
    }
  }, [])

  const readContent = useCallback(async (id: string): Promise<string | null> => {
    return window.api.assets.readContent(id)
  }, [])

  const saveContent = useCallback(async (id: string, content: string): Promise<void> => {
    await window.api.assets.update({ id, content })
  }, [])

  const uploadAsset = useCallback(async (sourcePath: string, title?: string): Promise<TaskAsset | null> => {
    if (!taskId) return null
    const asset = await window.api.assets.upload({ taskId, sourcePath, title })
    if (asset) {
      setAssets(prev => [...prev, asset])
      setSelectedId(asset.id)
      track('asset_created')
    }
    return asset
  }, [taskId])

  const getFilePath = useCallback(async (id: string): Promise<string | null> => {
    return window.api.assets.getFilePath(id)
  }, [])

  const downloadFile = useCallback(async (id: string): Promise<boolean> => {
    return window.api.assets.downloadFile(id)
  }, [])

  const downloadFolder = useCallback(async (id: string): Promise<boolean> => {
    return window.api.assets.downloadFolder(id)
  }, [])

  const uploadDir = useCallback(async (dirPath: string, parentFolderId?: string | null): Promise<void> => {
    if (!taskId) return
    await window.api.assets.uploadDir({ taskId, dirPath, parentFolderId: parentFolderId ?? null })
    // Reload everything after bulk operation
    const [newAssets, newFolders] = await Promise.all([
      window.api.assets.getByTask(taskId),
      window.api.assetFolders.getByTask(taskId),
    ])
    setAssets(newAssets)
    setFolders(newFolders)
  }, [taskId])

  // --- Folder CRUD ---

  const createFolder = useCallback(async (params: { name: string; parentId?: string | null }): Promise<AssetFolder | null> => {
    if (!taskId) return null
    const folder = await window.api.assetFolders.create({ taskId, ...params })
    if (folder) {
      setFolders(prev => [...prev, folder])
    }
    return folder
  }, [taskId])

  const updateFolder = useCallback(async (data: UpdateAssetFolderInput): Promise<void> => {
    const updated = await window.api.assetFolders.update(data)
    if (updated) {
      setFolders(prev => prev.map(f => f.id === data.id ? updated : f))
    }
  }, [])

  const deleteFolder = useCallback(async (id: string): Promise<void> => {
    await window.api.assetFolders.delete(id)
    setFolders(prev => prev.filter(f => f.id !== id))
    // Assets in deleted folder get folder_id = NULL (DB handles it), refresh local state
    setAssets(prev => prev.map(a => a.folder_id === id ? { ...a, folder_id: null } : a))
  }, [])

  const renameFolder = useCallback(async (id: string, newName: string): Promise<void> => {
    const updated = await window.api.assetFolders.update({ id, name: newName })
    if (updated) {
      setFolders(prev => prev.map(f => f.id === id ? updated : f))
    }
  }, [])

  return {
    assets, folders, selectedId, setSelectedId,
    createAsset, updateAsset, deleteAsset, renameAsset, moveAssetToFolder,
    readContent, saveContent, uploadAsset, uploadDir, getFilePath,
    downloadFile, downloadFolder,
    createFolder, updateFolder, deleteFolder, renameFolder,
    getAssetPath, pathToFolderId, folderPathMap,
  }
}
