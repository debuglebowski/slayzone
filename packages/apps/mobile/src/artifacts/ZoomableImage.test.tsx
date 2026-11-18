import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Image } from 'react-native'
import { ZoomableImage } from './ZoomableImage'

const layout = (width: number, height: number) => ({
  nativeEvent: { layout: { x: 0, y: 0, width, height } }
})

afterEach(() => jest.restoreAllMocks())

function sized(result: Promise<{ width: number; height: number }>) {
  jest.spyOn(Image, 'getSize').mockImplementation((() => result) as unknown as typeof Image.getSize)
}

describe('ZoomableImage', () => {
  it('a double tap zooms to 2x, another back to fit', async () => {
    sized(Promise.resolve({ width: 400, height: 200 }))
    await render(<ZoomableImage uri="file:///a.png" testID="img" />)
    await act(async () => fireEvent(screen.getByTestId('img'), 'layout', layout(300, 600)))
    const scroll = () => screen.getByTestId('img-scroll').props as { zoomScale: number }
    expect(scroll().zoomScale).toBe(1)
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    await act(async () => fireEvent.press(screen.getByTestId('img-picture')))
    now.mockReturnValue(1200)
    await act(async () => fireEvent.press(screen.getByTestId('img-picture')))
    expect(scroll().zoomScale).toBe(2)
    now.mockReturnValue(2000)
    await act(async () => fireEvent.press(screen.getByTestId('img-picture')))
    now.mockReturnValue(2100)
    await act(async () => fireEvent.press(screen.getByTestId('img-picture')))
    expect(scroll().zoomScale).toBe(1)
    // Two taps far apart are no double tap.
    now.mockReturnValue(5000)
    await act(async () => fireEvent.press(screen.getByTestId('img-picture')))
    now.mockReturnValue(6000)
    await act(async () => fireEvent.press(screen.getByTestId('img-picture')))
    expect(scroll().zoomScale).toBe(1)
  })

  it("an image that can't be read says so instead of staying blank", async () => {
    sized(Promise.reject(new Error('unsupported image')))
    await render(<ZoomableImage uri="file:///a.heic" testID="img" />)
    await act(async () => fireEvent(screen.getByTestId('img'), 'layout', layout(300, 600)))
    expect(await screen.findByText("This image couldn't be shown.")).toBeOnTheScreen()
  })
})
