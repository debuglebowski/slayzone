/**
 * Choosing what to upload: photos from the library (several at once), a photo taken with
 * the camera, or files from the Files app (several, any type). Each pick is a local
 * `file://` copy plus the name the artifact gets.
 *
 * Photos come JPEG-compatible (`Compatible`: iOS converts HEIC), since desktop's
 * Chromium cannot show HEIC. A picked name keeps its base but takes the extension of the
 * file actually delivered (`IMG_1.HEIC` → `IMG_1.jpg`), because the extension picks the
 * viewer everywhere. A photo without a name is named by the time, the way desktop names a
 * pasted image (`photo-2026-10-30T12-00-00-000Z.jpg` ~ `pasted-…`).
 */
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'

export type UploadSource = 'photos' | 'camera' | 'files'

export interface PickedFile {
  uri: string
  name: string
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

/** Same format, two spellings: keep the user's. */
const sameFormat = (a: string, b: string): boolean => {
  const norm = (ext: string) => (ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase())
  return norm(a) === norm(b)
}

/** The artifact title for a picked file; see the module comment. */
export function uploadTitle(
  pickedName: string | null | undefined,
  uri: string,
  now: Date = new Date()
): string {
  const delivered = extensionOf(decodeURIComponent(uri.split(/[?#]/, 1)[0].split('/').pop() ?? ''))
  const name = pickedName?.trim()
  if (name) {
    const ext = extensionOf(name)
    if (!delivered || sameFormat(ext, delivered)) return name
    const base = ext ? name.slice(0, name.length - ext.length - 1) : name
    return `${base}.${delivered.toLowerCase()}`
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return delivered ? `photo-${stamp}.${delivered.toLowerCase()}` : `photo-${stamp}`
}

/** Why a picker could not open. */
export class PickerPermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PickerPermissionError'
  }
}

/** Opens the picker for `source`; [] = cancelled. */
export async function pickUploads(
  source: UploadSource,
  now: Date = new Date()
): Promise<PickedFile[]> {
  switch (source) {
    case 'photos': {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 1,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible
      })
      if (result.canceled) return []
      return result.assets.map((a) => ({ uri: a.uri, name: uploadTitle(a.fileName, a.uri, now) }))
    }
    case 'camera': {
      const permission = await ImagePicker.requestCameraPermissionsAsync()
      if (!permission.granted) {
        throw new PickerPermissionError(
          'SlayZone may not use the camera. Allow it in Settings › SlayZone.'
        )
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
      if (result.canceled) return []
      return result.assets.map((a) => ({ uri: a.uri, name: uploadTitle(a.fileName, a.uri, now) }))
    }
    case 'files': {
      const result = await File.pickFileAsync({ multipleFiles: true })
      if (result.canceled) return []
      return result.result.map((f) => ({ uri: f.uri, name: uploadTitle(f.name, f.uri, now) }))
    }
  }
}
