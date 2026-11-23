import { render, screen, userEvent } from '@testing-library/react-native'
import * as WebBrowser from 'expo-web-browser'
import { StyleSheet } from 'react-native'
import { Markdown } from './Markdown'

// Links open in the in-app browser (Safari View Controller), the app stays in front.
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({})) }))
const open = jest.mocked(WebBrowser.openBrowserAsync)
beforeEach(() => open.mockClear())

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
    await render(<Markdown text={'[site](https://example.com) and [local](file:///etc/passwd)'} />)
    const user = userEvent.setup()
    await user.press(screen.getByText('site'))
    expect(open).toHaveBeenCalledWith('https://example.com')
    await user.press(screen.getByText('local'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('hands links to onLink first; a link it takes is not opened as a web link', async () => {
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
  })

  it('renders text that is still streaming, unfinished markup included', async () => {
    await render(<Markdown text={'Partial **bol'} />)
    expect(screen.getByText(/Partial/)).toBeOnTheScreen()
  })

  it('lines a table up in columns: every cell of a column is as wide, aligned as written', async () => {
    await render(
      <Markdown
        text={['| Name | Count |', '|---|--:|', '| a | 1 |', '| a much longer name | 12345 |'].join(
          '\n'
        )}
      />
    )
    const cell = (text: string) => {
      const parent = screen.getByText(text).parent?.parent
      return StyleSheet.flatten(parent?.props.style) as { width?: number }
    }
    expect(cell('a').width).toBeGreaterThan(0)
    expect(cell('a').width).toBe(cell('a much longer name').width)
    expect(cell('Name').width).toBe(cell('a').width)
    expect(cell('1').width).toBe(cell('12345').width)
    expect(StyleSheet.flatten(screen.getByText('1').parent?.props.style).textAlign).toBe('right')
  })
})

it('gives a wide table a bounded viewport and room for every column', async () => {
  const headings = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Last']
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`
  await render(
    <Markdown
      text={[
        row(headings),
        row(headings.map(() => '---')),
        row(headings.map((heading) => `${heading} cell`))
      ].join('\n')}
    />
  )
  const scroll = screen.getByTestId('markdown-table-scroll')
  expect(scroll.props.horizontal).toBe(true)
  expect(StyleSheet.flatten(scroll.props.style).width).toBe('100%')
  const table = screen.getByText('Last').parent?.parent?.parent?.parent
  expect(StyleSheet.flatten(table?.props.style).width).toBeGreaterThan(480)
  expect(screen.getByText('Last cell')).toBeOnTheScreen()
})
