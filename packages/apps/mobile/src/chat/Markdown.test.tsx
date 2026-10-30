import { render, screen, userEvent } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { Markdown } from './Markdown'

describe('Markdown', () => {
  it('renders GitHub-flavoured markdown as native text', async () => {
    await render(
      <Markdown
        text={[
          '# Title',
          '',
          'Some **bold**, *em*, ~~gone~~ and `code`.',
          '',
          '- one',
          '- [x] done',
          '',
          '1. first',
          '',
          '> quoted',
          '',
          '```ts',
          'const x = 1',
          '```',
          '',
          '| a | b |',
          '|---|---|',
          '| 1 | 2 |'
        ].join('\n')}
      />
    )
    expect(screen.getByText('Title')).toBeOnTheScreen()
    expect(screen.getByText('bold')).toBeOnTheScreen()
    expect(screen.getByText('gone')).toBeOnTheScreen()
    expect(screen.getByText('code')).toBeOnTheScreen()
    expect(screen.getByText('one')).toBeOnTheScreen()
    expect(screen.getByText('done')).toBeOnTheScreen()
    expect(screen.getByText('first')).toBeOnTheScreen()
    expect(screen.getByText('quoted')).toBeOnTheScreen()
    expect(screen.getByText('const x = 1')).toBeOnTheScreen()
    expect(screen.getByText('2')).toBeOnTheScreen()
  })

  it('opens web links, and only those', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    await render(<Markdown text={'[site](https://example.com) and [local](file:///etc/passwd)'} />)
    const user = userEvent.setup()
    await user.press(screen.getByText('site'))
    expect(open).toHaveBeenCalledWith('https://example.com')
    await user.press(screen.getByText('local'))
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
  })

  it('hands links to onLink first; a link it takes is not opened as a web link', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    const onLink = jest.fn((href: string) => href.startsWith('artifact:'))
    await render(
      <Markdown
        text={'[spec](artifact:a1), [img](artifact:a2) and [site](https://example.com)'}
        onLink={onLink}
      />
    )
    const user = userEvent.setup()
    await user.press(screen.getByText('spec'))
    expect(onLink).toHaveBeenLastCalledWith('artifact:a1')
    expect(open).not.toHaveBeenCalled()
    await user.press(screen.getByText('site'))
    expect(onLink).toHaveBeenLastCalledWith('https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com')
    open.mockRestore()
  })

  it('renders text that is still streaming, unfinished markup included', async () => {
    await render(<Markdown text={'Partial **bol'} />)
    expect(screen.getByText(/Partial/)).toBeOnTheScreen()
  })
})
