import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'
import { pickUploads, uploadTitle } from './pick-uploads'

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' }
}))
jest.mock('expo-file-system', () => ({ File: { pickFileAsync: jest.fn() } }))

const picker = jest.mocked(ImagePicker)
const pickFile = jest.mocked(File.pickFileAsync)
const NOW = new Date('2026-10-30T12:00:00.000Z')

describe('uploadTitle', () => {
  it('keeps the picked name, with the extension of the file actually picked', () => {
    expect(uploadTitle('IMG_0001.HEIC', 'file:///tmp/ABC.jpg', NOW)).toBe('IMG_0001.jpg')
    expect(uploadTitle('Spec.pdf', 'file:///tmp/Spec.pdf', NOW)).toBe('Spec.pdf')
    expect(uploadTitle('photo.jpeg', 'file:///tmp/x.jpg', NOW)).toBe('photo.jpeg')
    expect(uploadTitle('README', 'file:///tmp/README', NOW)).toBe('README')
  })

  it('names an unnamed photo like desktop names a pasted image, by the time', () => {
    expect(uploadTitle(null, 'file:///tmp/1F2E.jpg', NOW)).toBe(
      'photo-2026-10-30T12-00-00-000Z.jpg'
    )
    expect(uploadTitle('  ', 'file:///tmp/noext', NOW)).toBe('photo-2026-10-30T12-00-00-000Z')
  })
})

describe('pickUploads', () => {
  beforeEach(() => jest.resetAllMocks())

  it('photos: several at once, as JPEG-compatible files', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///tmp/a.jpg', fileName: 'IMG_1.HEIC' },
        { uri: 'file:///tmp/b.png', fileName: 'Shot.png' }
      ]
    } as never)
    await expect(pickUploads('photos', NOW)).resolves.toEqual([
      { uri: 'file:///tmp/a.jpg', name: 'IMG_1.jpg' },
      { uri: 'file:///tmp/b.png', name: 'Shot.png' }
    ])
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        preferredAssetRepresentationMode: 'compatible'
      })
    )
  })

  it('camera: asks for the camera first; a refusal says where to allow it', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false } as never)
    await expect(pickUploads('camera', NOW)).rejects.toThrow(
      'SlayZone may not use the camera. Allow it in Settings › SlayZone.'
    )
    expect(picker.launchCameraAsync).not.toHaveBeenCalled()

    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never)
    picker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/c.jpg', fileName: null }]
    } as never)
    await expect(pickUploads('camera', NOW)).resolves.toEqual([
      { uri: 'file:///tmp/c.jpg', name: 'photo-2026-10-30T12-00-00-000Z.jpg' }
    ])
  })

  it('files: several at once, any type', async () => {
    pickFile.mockResolvedValue({
      canceled: false,
      result: [{ uri: 'file:///tmp/Spec.pdf', name: 'Spec.pdf' }]
    } as never)
    await expect(pickUploads('files', NOW)).resolves.toEqual([
      { uri: 'file:///tmp/Spec.pdf', name: 'Spec.pdf' }
    ])
    expect(pickFile).toHaveBeenCalledWith({ multipleFiles: true })
  })

  it('a cancelled picker picks nothing', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as never)
    pickFile.mockResolvedValue({ canceled: true, result: null } as never)
    await expect(pickUploads('photos', NOW)).resolves.toEqual([])
    await expect(pickUploads('files', NOW)).resolves.toEqual([])
  })
})
