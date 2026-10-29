import { describe, expect, it } from 'vitest'
import {
  createHubThemeCache,
  type HubThemeCacheStorage,
  pickHubThemeSettings
} from './hub-theme-cache'
import { type HubThemeSettings, resolveNativeTheme } from './native-theme'
import type { StoredAppTheme } from './selection'

/**
 * The mobile app's first paint: the theme inputs last read from a hub, kept between
 * launches in the platform's storage (here in memory), painted until the hub answers.
 */

const HUB = 'hub:wss://hub.example.com/trpc'
const OTHER_HUB = 'hub:ws://127.0.0.1:47822/trpc'

const settings = (
  stored: Partial<StoredAppTheme>,
  preference: string | null = 'system'
): HubThemeSettings => ({
  preference,
  stored: {
    themeId: null,
    split: null,
    themeIdDark: null,
    themeIdLight: null,
    legacyThemeId: null,
    ...stored
  }
})

/** The platform's storage: one text value, in memory; `broken` makes every call throw. */
function memoryStorage(text: string | null = null) {
  const storage = {
    text,
    broken: false,
    read(): string | null {
      if (storage.broken) throw new Error('unreadable')
      return storage.text
    },
    write(next: string): void {
      if (storage.broken) throw new Error('read-only')
      storage.text = next
    }
  }
  return storage
}

/** One app launch: a fresh cache over what the storage kept. */
const launch = (storage: HubThemeCacheStorage) => createHubThemeCache(storage)

/** What the app paints before the hub answers (live = null). */
const firstPaint = (storage: HubThemeCacheStorage, device: 'light' | 'dark') =>
  resolveNativeTheme(pickHubThemeSettings(null, launch(storage).load(HUB)), device)

describe('pickHubThemeSettings: live once loaded, until then the cached ones', () => {
  const cached = settings({ themeId: 'nord' })
  const live = settings({ themeId: 'dracula' })

  it('live settings win (the same object)', () => {
    expect(pickHubThemeSettings(live, cached)).toBe(live)
    expect(pickHubThemeSettings(live, null)).toBe(live)
  })

  it('before they load: the cached ones; neither: null (the default preset)', () => {
    expect(pickHubThemeSettings(null, cached)).toBe(cached)
    expect(pickHubThemeSettings(null, null)).toBeNull()
  })
})

describe('createHubThemeCache', () => {
  describe('a launch paints the inputs the last one kept', () => {
    it('nothing kept → null: slay in the device scheme', () => {
      const storage = memoryStorage()
      expect(launch(storage).load(HUB)).toBeNull()
      expect(firstPaint(storage, 'dark')).toEqual(resolveNativeTheme(null, 'dark'))
      expect(firstPaint(storage, 'light').themeId).toBe('slay')
    })

    it('kept inputs are painted before the live settings arrive', () => {
      const storage = memoryStorage()
      const kept = settings({ themeId: 'catppuccin' }, 'light')
      launch(storage).save(HUB, kept)

      expect(launch(storage).load(HUB)).toEqual(kept)
      const painted = firstPaint(storage, 'dark')
      expect(painted).toMatchObject({ themeId: 'catppuccin', variant: 'light' })
      expect(painted).toEqual(resolveNativeTheme(kept, 'dark'))
    })

    it('live settings replace them, and are what the next launch paints', () => {
      const storage = memoryStorage()
      launch(storage).save(HUB, settings({ themeId: 'catppuccin' }))

      const cache = launch(storage)
      const cached = cache.load(HUB)
      const live = settings({ themeId: 'nord' }, 'dark')
      expect(pickHubThemeSettings(live, cached)).toBe(live)
      cache.save(HUB, live) // the app saves what the hub said, when it loads or changes

      expect(launch(storage).load(HUB)).toEqual(live)
      expect(firstPaint(storage, 'light')).toMatchObject({ themeId: 'nord', variant: 'dark' })
    })

    it('preference system: the kept choice follows the device scheme of THIS launch', () => {
      const storage = memoryStorage()
      launch(storage).save(
        HUB,
        settings({ split: '1', themeIdDark: 'dracula', themeIdLight: 'solarized' }, 'system')
      )
      expect(firstPaint(storage, 'light')).toMatchObject({ themeId: 'solarized', variant: 'light' })
      expect(firstPaint(storage, 'dark')).toMatchObject({ themeId: 'dracula', variant: 'dark' })
    })

    it('keeps the inputs as the hub said them: null preference, legacy and unknown ids', () => {
      for (const kept of [
        settings({}, null),
        settings({ themeId: null, legacyThemeId: 'solarized-dark' }, 'auto'),
        settings({ themeId: 'gone-theme' }, 'dark'),
        {
          preference: 'light',
          stored: { themeId: 'nord', split: '0', themeIdDark: null, themeIdLight: null }
        }
      ]) {
        const storage = memoryStorage()
        launch(storage).save(HUB, kept)
        expect(launch(storage).load(HUB)).toEqual(kept)
        for (const device of ['light', 'dark'] as const) {
          expect(firstPaint(storage, device)).toEqual(resolveNativeTheme(kept, device))
        }
      }
    })
  })

  describe('per hub', () => {
    it('each hub keeps its own; sign-out (forget) drops only that hub', () => {
      const storage = memoryStorage()
      const cache = launch(storage)
      cache.save(HUB, settings({ themeId: 'nord' }))
      cache.save(OTHER_HUB, settings({ themeId: 'dracula' }))
      expect(cache.load(HUB)).toEqual(settings({ themeId: 'nord' }))

      cache.forget(HUB)
      const next = launch(storage)
      expect(next.load(HUB)).toBeNull()
      expect(next.load(OTHER_HUB)).toEqual(settings({ themeId: 'dracula' }))
      expect(firstPaint(storage, 'dark')).toEqual(resolveNativeTheme(null, 'dark'))
    })

    it('forgetting a hub with nothing kept writes nothing', () => {
      const storage = memoryStorage()
      launch(storage).forget(HUB)
      expect(storage.text).toBeNull()
    })

    it('a hub id is only a key, even one naming an Object.prototype member', () => {
      const storage = memoryStorage()
      const cache = launch(storage)
      for (const id of ['__proto__', 'constructor', 'toString']) {
        expect(cache.load(id)).toBeNull()
        cache.save(id, settings({ themeId: id === 'constructor' ? 'nord' : 'dracula' }))
      }
      expect(launch(storage).load('__proto__')).toEqual(settings({ themeId: 'dracula' }))
      expect(launch(storage).load('constructor')).toEqual(settings({ themeId: 'nord' }))
      expect(launch(storage).load(HUB)).toBeNull()
    })
  })

  describe('loadLast: the hub signed in last, for the paint before the session is known', () => {
    it('nothing kept → null: slay in the device scheme', () => {
      expect(launch(memoryStorage()).loadLast()).toBeNull()
    })

    it('the hub whose settings were saved last', () => {
      const storage = memoryStorage()
      const cache = launch(storage)
      cache.save(HUB, settings({ themeId: 'nord' }))
      expect(launch(storage).loadLast()).toEqual(settings({ themeId: 'nord' }))
      cache.save(OTHER_HUB, settings({ themeId: 'dracula' }))
      expect(launch(storage).loadLast()).toEqual(settings({ themeId: 'dracula' }))
    })

    it('sign-out of that hub forgets it; forgetting another hub keeps it', () => {
      const storage = memoryStorage()
      const cache = launch(storage)
      cache.save(OTHER_HUB, settings({ themeId: 'dracula' }))
      cache.save(HUB, settings({ themeId: 'nord' }))
      cache.forget(OTHER_HUB)
      expect(launch(storage).loadLast()).toEqual(settings({ themeId: 'nord' }))
      cache.forget(HUB)
      expect(launch(storage).loadLast()).toBeNull()
    })

    it('a last hub that is not a string, or names no readable entry, is nothing kept', () => {
      const entry = { preference: 'dark', stored: settings({ themeId: 'nord' }).stored }
      for (const last of [42, null, OTHER_HUB]) {
        const text = JSON.stringify({ v: 1, last, hubs: { [HUB]: entry } })
        expect(launch(memoryStorage(text)).loadLast()).toBeNull()
        // The per-hub entries stay readable.
        expect(launch(memoryStorage(text)).load(HUB)).toEqual(settings({ themeId: 'nord' }, 'dark'))
      }
    })

    it('storage that throws: null, never throws', () => {
      const storage = memoryStorage()
      storage.broken = true
      expect(launch(storage).loadLast()).toBeNull()
    })
  })

  describe('unreadable storage counts as nothing kept, never throws', () => {
    const valid = settings({ themeId: 'nord' }, 'dark')
    const entry = (value: unknown) => JSON.stringify({ v: 1, hubs: { [HUB]: value } })
    const validText = entry(valid)

    it.each([
      ['empty', ''],
      ['not JSON', 'not json'],
      ['truncated', validText.slice(0, -3)],
      ['null', 'null'],
      ['a number', '42'],
      ['a string', '"nord"'],
      ['an array', '[]'],
      ['no version', JSON.stringify({ hubs: { [HUB]: valid } })],
      ['another version', JSON.stringify({ v: 2, hubs: { [HUB]: valid } })],
      ['no hubs', '{"v":1}'],
      ['hubs an array', '{"v":1,"hubs":[]}'],
      ['entry null', entry(null)],
      ['entry a string', entry('nord')],
      ['preference a number', entry({ ...valid, preference: 5 })],
      ['preference missing', entry({ stored: valid.stored })],
      ['stored missing', entry({ preference: 'dark' })],
      ['stored an array', entry({ preference: 'dark', stored: [] })],
      ['themeId a number', entry({ ...valid, stored: { ...valid.stored, themeId: 1 } })],
      ['split a boolean', entry({ ...valid, stored: { ...valid.stored, split: true } })],
      [
        'themeIdLight missing',
        entry({ ...valid, stored: { themeId: 'nord', split: null, themeIdDark: null } })
      ],
      [
        'legacyThemeId an object',
        entry({ ...valid, stored: { ...valid.stored, legacyThemeId: {} } })
      ]
    ])('%s → null, slay', (_, text) => {
      const storage = memoryStorage(text)
      expect(launch(storage).load(HUB)).toBeNull()
      expect(firstPaint(storage, 'light')).toEqual(resolveNativeTheme(null, 'light'))
    })

    it('a valid entry is read (the cases above differ from it in one thing each)', () => {
      expect(launch(memoryStorage(validText)).load(HUB)).toEqual(valid)
    })

    it('one bad entry costs only its hub', () => {
      const storage = memoryStorage(
        JSON.stringify({ v: 1, hubs: { [HUB]: { preference: 1 }, [OTHER_HUB]: valid } })
      )
      expect(launch(storage).load(HUB)).toBeNull()
      expect(launch(storage).load(OTHER_HUB)).toEqual(valid)
    })

    it('saving over unreadable data replaces it', () => {
      const storage = memoryStorage('not json')
      launch(storage).save(HUB, valid)
      expect(launch(storage).load(HUB)).toEqual(valid)
    })

    it('storage that throws: load → null, save and forget do not throw', () => {
      const storage = memoryStorage()
      launch(storage).save(HUB, valid)
      storage.broken = true
      const cache = launch(storage)
      expect(cache.load(HUB)).toBeNull()
      expect(() => cache.save(HUB, valid)).not.toThrow()
      expect(() => cache.forget(HUB)).not.toThrow()
    })
  })
})
