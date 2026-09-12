import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { newOrChangedMedia, scanMedia, type MediaFile } from '../../src/main/artifacts/mediaScan'
import { isMediaArtifact, mediaAddedMessage, mediaKindFor } from '../../src/shared/mediaArtifacts'

const created: string[] = []

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-media-'))
  created.push(dir)
  return dir
}

function write(root: string, relative: string, contents = 'x'): string {
  const full = path.join(root, relative)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
  return full
}

const names = (files: MediaFile[]): string[] => files.map((file) => path.basename(file.filePath)).sort()

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

describe('what counts as media', () => {
  it('recognizes the prioritized formats', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'a.svg', 'a.mp4', 'a.webm']) {
      expect(isMediaArtifact(name), name).toBe(true)
    }
  })

  it('does not classify source code or ordinary project files as media', () => {
    // The requirement that matters: an agent writing code produces nothing
    // here, so its files stay in Files.
    for (const name of ['index.ts', 'App.tsx', 'style.css', 'data.json', 'README.md', 'go.sum', '.gitignore', 'Makefile']) {
      expect(isMediaArtifact(name), name).toBe(false)
    }
  })

  it('separates images from video for the notification wording', () => {
    expect(mediaKindFor('render.png')).toBe('image')
    expect(mediaKindFor('clip.mp4')).toBe('video')
    expect(mediaAddedMessage('image')).toBe('Image added to Artifacts')
    expect(mediaAddedMessage('video')).toBe('Video added to Artifacts')
  })

  it('ignores case in the extension', () => {
    expect(isMediaArtifact('MOUNTAIN.PNG')).toBe(true)
  })

  it('is not fooled by an extension in the middle of a name', () => {
    expect(isMediaArtifact('notes.png.txt')).toBe(false)
  })
})

describe('scanning a workspace', () => {
  it('finds media and nothing else', () => {
    const root = workspace()
    write(root, 'mountain.png')
    write(root, 'clip.mp4')
    write(root, 'src/index.ts')
    write(root, 'package.json')

    expect(names([...scanMedia(root).values()])).toEqual(['clip.mp4', 'mountain.png'])
  })

  it('finds media in a subfolder', () => {
    const root = workspace()
    write(root, 'output/renders/peak.png')

    expect(names([...scanMedia(root).values()])).toEqual(['peak.png'])
  })

  it('skips machine-managed and vendored folders', () => {
    const root = workspace()
    write(root, 'node_modules/pkg/logo.png')
    write(root, '.git/thing.png')
    write(root, 'dist/bundle.png')
    write(root, 'real.png')

    expect(names([...scanMedia(root).values()])).toEqual(['real.png'])
  })

  it('ignores an empty file', () => {
    const root = workspace()
    write(root, 'placeholder.png', '')

    expect([...scanMedia(root).values()]).toEqual([])
  })

  it('returns nothing for a folder that does not exist', () => {
    expect(scanMedia('/orbit/nope').size).toBe(0)
  })

  it('returns nothing for an empty path', () => {
    expect(scanMedia('').size).toBe(0)
  })
})

describe('diffing across a turn', () => {
  it('reports a file the turn created', () => {
    const root = workspace()
    const before = scanMedia(root)
    write(root, 'generated.png')

    expect(names(newOrChangedMedia(before, scanMedia(root)))).toEqual(['generated.png'])
  })

  it('reports nothing when the turn produced nothing', () => {
    const root = workspace()
    write(root, 'existing.png')
    const before = scanMedia(root)

    // The case that matters: a turn that only answered a question must not
    // register the folder it happened to run in.
    expect(newOrChangedMedia(before, scanMedia(root))).toEqual([])
  })

  it('reports a file the turn overwrote', () => {
    const root = workspace()
    write(root, 'sky.png', 'light')
    const before = scanMedia(root)
    write(root, 'sky.png', 'darker and longer contents')

    expect(names(newOrChangedMedia(before, scanMedia(root)))).toEqual(['sky.png'])
  })

  it('ignores source files the turn created', () => {
    const root = workspace()
    const before = scanMedia(root)
    write(root, 'src/newModule.ts')
    write(root, 'src/newModule.test.ts')

    expect(newOrChangedMedia(before, scanMedia(root))).toEqual([])
  })

  it('reports several in the order they were written', () => {
    const root = workspace()
    const before = scanMedia(root)
    const first = write(root, 'one.png')
    fs.utimesSync(first, new Date(1000), new Date(1000))
    const second = write(root, 'two.png')
    fs.utimesSync(second, new Date(2000), new Date(2000))

    expect(newOrChangedMedia(before, scanMedia(root)).map((file) => path.basename(file.filePath))).toEqual([
      'one.png',
      'two.png'
    ])
  })

  it('does not report a file that was deleted during the turn', () => {
    const root = workspace()
    const target = write(root, 'gone.png')
    const before = scanMedia(root)
    fs.rmSync(target)

    expect(newOrChangedMedia(before, scanMedia(root))).toEqual([])
  })
})
