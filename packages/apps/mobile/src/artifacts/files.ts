/**
 * The artifact file cache on the device (`file-cache.ts` holds the logic): files under the
 * caches directory (`expo-file-system`, `Paths.cache`). A hub served inside the app (the
 * demo hub, `target.http`) hands over the bytes itself; they are written to the same
 * place.
 */
import { Directory, File, Paths } from 'expo-file-system'
import { bodyBytes, type InProcessHttp } from '../in-process-hub'
import {
  type ArtifactFileSource,
  type ArtifactFileStore,
  downloadArtifactFileTo,
  forgetArtifactCacheIn
} from './file-cache'
import type { HubTarget } from './hub-rest'

export * from './file-cache'

/** The store on the device: `expo-file-system` under `Paths.cache`. */
export const deviceFileStore: ArtifactFileStore = {
  find(dir, name) {
    const file = new File(new Directory(Paths.cache, ...dir), name)
    return file.exists ? file.uri : null
  },
  async download(url, headers, dir, name) {
    const directory = new Directory(Paths.cache, ...dir)
    directory.create({ intermediates: true, idempotent: true })
    const file = await File.downloadFileAsync(url, new File(directory, name), {
      headers,
      idempotent: true
    })
    return file.uri
  },
  removeExcept(dir, keep) {
    const directory = new Directory(Paths.cache, ...dir)
    if (!directory.exists) return
    if (keep === null) {
      directory.delete()
      return
    }
    for (const entry of directory.list()) {
      if (entry.name !== keep) entry.delete()
    }
  }
}

/**
 * The device's store, downloading from a hub served inside the app: its answer's bytes
 * are written to the file. A failure reads like the OS downloader's (`… response has
 * status N`), which `file-cache.ts` reads the status from.
 */
export function inProcessFileStore(http: InProcessHttp): ArtifactFileStore {
  return {
    ...deviceFileStore,
    async download(url, headers, dir, name) {
      const res = await http({ method: 'GET', url, headers })
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Unable to download file: response has status ${res.status}`)
      }
      const directory = new Directory(Paths.cache, ...dir)
      directory.create({ intermediates: true, idempotent: true })
      const file = new File(directory, name)
      file.create({ overwrite: true })
      await file.write(bodyBytes(res.body))
      return file.uri
    }
  }
}

/** The artifact (or one version) as a local file; see `file-cache.ts`. */
export function downloadArtifactFile(
  target: HubTarget,
  source: ArtifactFileSource,
  store: ArtifactFileStore = target.http ? inProcessFileStore(target.http) : deviceFileStore
): Promise<string> {
  return downloadArtifactFileTo(store, target, source)
}

/** Deletes every file kept from one hub (its sign-out). */
export function forgetArtifactCache(
  hubId: string,
  store: ArtifactFileStore = deviceFileStore
): void {
  forgetArtifactCacheIn(store, hubId)
}
