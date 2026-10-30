import { tabPathOfLink } from './deep-links'

describe('tabPathOfLink', () => {
  it.each([
    ['slayzone://task/home.example/t0', '/(tabs)/(tasks)/task/home.example/t0'],
    ['/task/127.0.0.1%3A8788/t0', '/(tabs)/(tasks)/task/127.0.0.1%3A8788/t0'],
    ['slayzone://projects', '/(tabs)/(tasks)/projects'],
    ['slayzone://projects/home.example/p', '/(tabs)/(tasks)/projects/home.example/p'],
    [
      'slayzone://agent/home.example/t0?tab=side',
      '/(tabs)/(agents)/agent/home.example/t0?tab=side'
    ],
    ['slayzone://artifacts/home.example/t0', '/(tabs)/(search)/artifacts/home.example/t0'],
    [
      'slayzone:///artifacts/home.example/t0/a1?version=3',
      '/(tabs)/(search)/artifacts/home.example/t0/a1?version=3'
    ]
  ])('opens %s in its tab', (link, path) => {
    expect(tabPathOfLink(link)).toBe(path)
  })

  it.each([
    'slayzone://auth/callback?code=c&state=s',
    'slayzone://',
    '/',
    '/tasks',
    '/artifacts',
    '/hubs',
    '/add-hub',
    '/agents',
    'slayzone://sign-in',
    '/(tabs)/(tasks)/task/home.example/t0'
  ])('leaves %s as it is (one screen, or already in a tab)', (link) => {
    expect(tabPathOfLink(link)).toBe(link)
  })
})
