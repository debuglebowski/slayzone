import { decideNavigation } from './navigation'

const top = (url: string) => ({ url, isTopFrame: true })

describe('decideNavigation', () => {
  it('loads the page itself and its in-page anchors', () => {
    expect(decideNavigation(top('about:blank'))).toEqual({ kind: 'load' })
    expect(decideNavigation(top('about:blank#section-2'))).toEqual({ kind: 'load' })
    expect(decideNavigation(top('about:srcdoc'))).toEqual({ kind: 'load' })
  })

  it('lets a report navigate inside its own frame, as desktop’s frame does', () => {
    expect(decideNavigation({ url: 'https://example.com/x', isTopFrame: false })).toEqual({
      kind: 'load'
    })
  })

  it('opens another artifact in the app', () => {
    expect(decideNavigation(top('artifact:6f1c-22'))).toEqual({
      kind: 'open-artifact',
      artifactId: '6f1c-22'
    })
    expect(decideNavigation(top('artifact:'))).toEqual({ kind: 'block' })
  })

  it('opens web and mail links outside the app', () => {
    expect(decideNavigation(top('https://example.com/a?b=1'))).toEqual({
      kind: 'open-external',
      url: 'https://example.com/a?b=1'
    })
    expect(decideNavigation(top('mailto:me@example.com'))).toEqual({
      kind: 'open-external',
      url: 'mailto:me@example.com'
    })
  })

  it('loads the local file a page is (PDF) and nothing else from the device', () => {
    expect(
      decideNavigation(top('file:///cache/a1/spec.pdf'), { fileUri: 'file:///cache/a1/spec.pdf' })
    ).toEqual({
      kind: 'load'
    })
    expect(
      decideNavigation(top('file:///etc/passwd'), { fileUri: 'file:///cache/a1/spec.pdf' })
    ).toEqual({
      kind: 'block'
    })
    // iOS: /var is /private/var; WebKit may name the cache file either way.
    expect(
      decideNavigation(top('file:///private/var/mobile/Caches/a1/My%20spec.pdf#page=2'), {
        fileUri: 'file:///var/mobile/Caches/a1/My%20spec.pdf'
      })
    ).toEqual({ kind: 'load' })
    expect(
      decideNavigation(top('file:///var/mobile/Caches/a1/other.pdf'), {
        fileUri: 'file:///var/mobile/Caches/a1/My%20spec.pdf'
      })
    ).toEqual({ kind: 'block' })
    expect(decideNavigation(top('javascript:alert(1)'))).toEqual({ kind: 'block' })
    expect(decideNavigation(top('slayzone://task/x/y'))).toEqual({ kind: 'block' })
  })
})
