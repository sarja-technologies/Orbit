import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { newOrChangedOutputs, scanOutputs, type OutputFile } from '../../src/main/artifacts/outputScan'
import {
  hasInlinePreview,
  isOpenableOutput,
  isTemporaryName,
  mediaAddedMessage,
  mediaKindFor,
  outputFormatFor,
  outputTypeLabel
} from '../../src/shared/outputArtifacts'

const isOutput = (name: string): boolean => outputFormatFor(name) !== null

const created: string[] = []

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-outputs-'))
  created.push(dir)
  return dir
}

function write(root: string, relative: string, contents = 'x'): string {
  const full = path.join(root, relative)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
  return full
}

const names = (files: OutputFile[]): string[] => files.map((file) => path.basename(file.filePath)).sort()

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

describe('what counts as an output', () => {
  it('recognizes images, video, documents, data and archives', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'a.svg', 'a.mp4', 'a.webm', 'report.pdf', 'analysis.csv', 'output.zip', 'deck.pptx', 'sheet.xlsx', 'track.mp3']) {
      expect(isOutput(name), name).toBe(true)
    }
  })

  it('does not classify source code or ordinary project files as outputs', () => {
    // The requirement that matters: an agent writing code produces no cards.
    for (const name of ['index.ts', 'App.tsx', 'style.css', 'data.json', 'go.sum', '.gitignore', 'Makefile', 'index.html', 'build.sh', 'main.py', 'Cargo.lock']) {
      expect(isOutput(name), name).toBe(false)
    }
  })

  it('only lets plain text through on stronger evidence', () => {
    expect(outputFormatFor('summary.md')?.evidence).toBe('created-and-named')
    expect(outputFormatFor('README.md')).toBeNull()
    expect(outputFormatFor('CHANGELOG.txt')).toBeNull()
    expect(outputFormatFor('notes.txt')?.evidence).toBe('created-and-named')
    expect(outputFormatFor('mountain.png')?.evidence).toBe('created-or-changed')
  })

  it('never treats a temporary or lock file as an output', () => {
    for (const name of ['.hidden.png', '~$report.docx', 'render.png.tmp', 'video.mp4.part', 'download.pdf.crdownload', 'draft.pdf~']) {
      expect(isTemporaryName(name), name).toBe(true)
      expect(isOutput(name), name).toBe(false)
    }
  })

  it('separates images from video for the notification wording', () => {
    expect(mediaKindFor('render.png')).toBe('image')
    expect(mediaKindFor('clip.mp4')).toBe('video')
    expect(mediaKindFor('report.pdf')).toBeNull()
    expect(mediaAddedMessage('image')).toBe('Image added to Artifacts')
    expect(mediaAddedMessage('video')).toBe('Video added to Artifacts')
  })

  it('previews the web image formats inline and nothing else', () => {
    expect(hasInlinePreview('a.png')).toBe(true)
    expect(hasInlinePreview('a.gif')).toBe(true)
    expect(hasInlinePreview('a.pdf')).toBe(false)
    expect(hasInlinePreview('a.mp4')).toBe(false)
  })

  it('never offers to open something executable', () => {
    for (const name of ['run.sh', 'Tool.app', 'setup.exe', 'page.html', 'script.command', 'x.js']) {
      expect(isOpenableOutput(name), name).toBe(false)
    }
    expect(isOpenableOutput('report.pdf')).toBe(true)
  })

  it('labels a file by what it is', () => {
    expect(outputTypeLabel('report.pdf')).toBe('PDF document')
    expect(outputTypeLabel('analysis.csv')).toBe('CSV data')
    expect(outputTypeLabel('bundle.zip')).toBe('ZIP archive')
  })

  it('ignores case in the extension', () => {
    expect(isOutput('MOUNTAIN.PNG')).toBe(true)
  })

  it('is not fooled by an extension in the middle of a name', () => {
    expect(isOutput('notes.png.ts')).toBe(false)
  })
})

describe('scanning a workspace', () => {
  it('finds outputs and nothing else', () => {
    const root = workspace()
    write(root, 'mountain.png')
    write(root, 'clip.mp4')
    write(root, 'report.pdf')
    write(root, 'src/index.ts')
    write(root, 'package.json')

    expect(names([...scanOutputs(root).values()])).toEqual(['clip.mp4', 'mountain.png', 'report.pdf'])
  })

  it('finds names with spaces and non-Latin characters', () => {
    const root = workspace()
    write(root, 'Mountain view 山.png')

    expect(names([...scanOutputs(root).values()])).toEqual(['Mountain view 山.png'])
  })

  it('does not follow a symlink out of the workspace', () => {
    const root = workspace()
    const outside = workspace()
    write(outside, 'secret.png')
    fs.symlinkSync(outside, path.join(root, 'linked'))
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'alias.png'))

    expect([...scanOutputs(root).values()]).toEqual([])
  })

  it('skips an excluded folder, such as Orbit’s own data', () => {
    const root = workspace()
    write(root, 'orbit-data/projects/p/artifacts/copy.png')
    write(root, 'fresh.png')

    expect(names([...scanOutputs(root, [path.join(root, 'orbit-data')]).values()])).toEqual(['fresh.png'])
  })

  it('finds media in a subfolder', () => {
    const root = workspace()
    write(root, 'output/renders/peak.png')

    expect(names([...scanOutputs(root).values()])).toEqual(['peak.png'])
  })

  it('skips machine-managed and vendored folders', () => {
    const root = workspace()
    write(root, 'node_modules/pkg/logo.png')
    write(root, '.git/thing.png')
    write(root, 'dist/bundle.png')
    write(root, '.cache/thumb.png')
    write(root, '.venv/lib/icon.png')
    write(root, 'real.png')

    expect(names([...scanOutputs(root).values()])).toEqual(['real.png'])
  })

  it('ignores an empty file', () => {
    const root = workspace()
    write(root, 'placeholder.png', '')

    expect([...scanOutputs(root).values()]).toEqual([])
  })

  it('returns nothing for a folder that does not exist', () => {
    expect(scanOutputs('/orbit/nope').size).toBe(0)
  })

  it('returns nothing for an empty path', () => {
    expect(scanOutputs('').size).toBe(0)
  })
})

describe('diffing across a turn', () => {
  it('reports a file the turn created', () => {
    const root = workspace()
    const before = scanOutputs(root)
    write(root, 'generated.png')

    expect(names(newOrChangedOutputs(before, scanOutputs(root)))).toEqual(['generated.png'])
  })

  it('reports nothing when the turn produced nothing', () => {
    const root = workspace()
    write(root, 'existing.png')
    const before = scanOutputs(root)

    // The case that matters: a turn that only answered a question must not
    // register the folder it happened to run in.
    expect(newOrChangedOutputs(before, scanOutputs(root))).toEqual([])
  })

  it('reports a file the turn overwrote', () => {
    const root = workspace()
    write(root, 'sky.png', 'light')
    const before = scanOutputs(root)
    write(root, 'sky.png', 'darker and longer contents')

    expect(names(newOrChangedOutputs(before, scanOutputs(root)))).toEqual(['sky.png'])
  })

  it('says whether the file is new or an existing one the turn changed', () => {
    const root = workspace()
    write(root, 'old.png', 'a')
    const before = scanOutputs(root)
    write(root, 'old.png', 'a longer body')
    write(root, 'new.png')

    const changed = newOrChangedOutputs(before, scanOutputs(root))
    expect(Object.fromEntries(changed.map((file) => [path.basename(file.filePath), file.created]))).toEqual({ 'old.png': false, 'new.png': true })
  })

  it('ignores source files the turn created', () => {
    const root = workspace()
    const before = scanOutputs(root)
    write(root, 'src/newModule.ts')
    write(root, 'src/newModule.test.ts')

    expect(newOrChangedOutputs(before, scanOutputs(root))).toEqual([])
  })

  it('reports several in the order they were written', () => {
    const root = workspace()
    const before = scanOutputs(root)
    const first = write(root, 'one.png')
    fs.utimesSync(first, new Date(1000), new Date(1000))
    const second = write(root, 'two.png')
    fs.utimesSync(second, new Date(2000), new Date(2000))

    expect(newOrChangedOutputs(before, scanOutputs(root)).map((file: OutputFile) => path.basename(file.filePath))).toEqual([
      'one.png',
      'two.png'
    ])
  })

  it('does not report a file that was deleted during the turn', () => {
    const root = workspace()
    const target = write(root, 'gone.png')
    const before = scanOutputs(root)
    fs.rmSync(target)

    expect(newOrChangedOutputs(before, scanOutputs(root))).toEqual([])
  })
})
