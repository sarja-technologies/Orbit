// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactToasts, type ArtifactNotice } from '../../src/renderer/app/components/ArtifactToast'

const image: ArtifactNotice = { artifactId: 'a1', name: 'mountain.png', kind: 'image' }
const video: ArtifactNotice = { artifactId: 'a2', name: 'clip.mp4', kind: 'video' }

function renderToasts(notices: ArtifactNotice[]) {
  const onOpen = vi.fn()
  const onDismiss = vi.fn()
  const view = render(<ArtifactToasts notices={notices} onOpen={onOpen} onDismiss={onDismiss} />)
  return { ...view, onOpen, onDismiss }
}

describe('the artifact notification', () => {
  it('says an image was added', () => {
    renderToasts([image])
    expect(screen.getByText('Image added to Artifacts')).toBeInTheDocument()
  })

  it('says a video was added', () => {
    renderToasts([video])
    expect(screen.getByText('Video added to Artifacts')).toBeInTheDocument()
  })

  it('names the file, so several in a row are distinguishable', () => {
    renderToasts([image])
    expect(screen.getByText('mountain.png')).toBeInTheDocument()
  })

  it('renders nothing when there is nothing to announce', () => {
    const { container } = renderToasts([])
    expect(container).toBeEmptyDOMElement()
  })

  it('shows one toast per artifact', () => {
    renderToasts([image, video])
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('does not interrupt: it never takes focus', () => {
    renderToasts([image])
    // Announced politely and left alone — the user keeps typing.
    expect(document.activeElement).toBe(document.body)
    expect(screen.getByRole('button').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
  })

  it('opens the artifact when clicked', async () => {
    const user = userEvent.setup()
    const { onOpen } = renderToasts([image])

    await user.click(screen.getByRole('button'))

    expect(onOpen).toHaveBeenCalledWith('a1')
  })
})

describe('the notification disappears on its own', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('dismisses itself without the user doing anything', () => {
    const onDismiss = vi.fn()
    render(<ArtifactToasts notices={[image]} onOpen={vi.fn()} onDismiss={onDismiss} />)

    expect(onDismiss).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(onDismiss).toHaveBeenCalledWith('a1')
  })

  it('does not dismiss before it could be read', () => {
    const onDismiss = vi.fn()
    render(<ArtifactToasts notices={[image]} onOpen={vi.fn()} onDismiss={onDismiss} />)

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('gives each toast its own timer', () => {
    const onDismiss = vi.fn()
    render(<ArtifactToasts notices={[image, video]} onOpen={vi.fn()} onDismiss={onDismiss} />)

    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(onDismiss).toHaveBeenCalledWith('a1')
    expect(onDismiss).toHaveBeenCalledWith('a2')
  })
})
