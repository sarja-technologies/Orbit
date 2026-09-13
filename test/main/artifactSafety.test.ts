// The low-level guarantees every artifact decision rests on: a path an
// agent produced is only ever used while it is a real file inside a folder
// Orbit allows, and a file only counts as a finished output when its own
// bytes say so.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCompleteness } from '../../src/main/artifacts/fileIntegrity'
import { canonicalDirectory, isWithin, resolveContainedFile } from '../../src/main/artifacts/safePaths'
import { gifBytes, jpegBytes, pdfBytes, pngBytes, zipBytes } from './fixtures/outputFiles'

const created: string[] = []
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-safety-')))
  created.push(dir)
  return dir
}
function write(root: string, relative: string, contents: string | Buffer = 'x'): string {
  const full = path.join(root, relative)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
  return full
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

describe('containment', () => {
  it('accepts a regular file inside its root', () => {
    const root = tempDir()
    const file = write(root, 'out/mountain.png')
    expect(resolveContainedFile(file, [root])).toBe(file)
  })

  it('refuses a path that climbs out with ..', () => {
    const root = tempDir()
    const outside = tempDir()
    write(outside, 'secret.pdf')
    const sneaky = path.join(root, '..', path.basename(outside), 'secret.pdf')
    expect(resolveContainedFile(sneaky, [root])).toBeNull()
  })

  it('refuses a symlink inside the root that points outside it', () => {
    const root = tempDir()
    const outside = tempDir()
    const secret = write(outside, 'id_rsa.png')
    const link = path.join(root, 'innocent.png')
    fs.symlinkSync(secret, link)
    expect(resolveContainedFile(link, [root])).toBeNull()
  })

  it('refuses a symlinked folder that leads outside', () => {
    const root = tempDir()
    const outside = tempDir()
    write(outside, 'deep/report.pdf')
    fs.symlinkSync(outside, path.join(root, 'linked'))
    expect(resolveContainedFile(path.join(root, 'linked', 'deep', 'report.pdf'), [root])).toBeNull()
  })

  it('refuses relative paths, directories, missing files and NUL bytes', () => {
    const root = tempDir()
    write(root, 'a.png')
    fs.mkdirSync(path.join(root, 'folder.png'))
    expect(resolveContainedFile('a.png', [root])).toBeNull()
    expect(resolveContainedFile(path.join(root, 'folder.png'), [root])).toBeNull()
    expect(resolveContainedFile(path.join(root, 'nope.png'), [root])).toBeNull()
    expect(resolveContainedFile(`${path.join(root, 'a.png')}\0.txt`, [root])).toBeNull()
  })

  it('does not treat a sibling with a shared prefix as inside', () => {
    expect(isWithin('/work/app', '/work/app-old/file.png')).toBe(false)
    expect(isWithin('/work/app', '/work/app/file.png')).toBe(true)
  })

  it('refuses when the root itself is not a real directory', () => {
    const root = tempDir()
    const file = write(root, 'x.png')
    expect(canonicalDirectory(file)).toBeNull()
    expect(resolveContainedFile(file, [null, undefined, 'relative/root'])).toBeNull()
  })
})

describe('completeness', () => {
  it('proves well-formed files complete', () => {
    const root = tempDir()
    expect(checkCompleteness(write(root, 'a.png', pngBytes()))).toBe('complete')
    expect(checkCompleteness(write(root, 'a.jpg', jpegBytes()))).toBe('complete')
    expect(checkCompleteness(write(root, 'a.gif', gifBytes()))).toBe('complete')
    expect(checkCompleteness(write(root, 'a.pdf', pdfBytes()))).toBe('complete')
    expect(checkCompleteness(write(root, 'a.zip', zipBytes()))).toBe('complete')
    expect(checkCompleteness(write(root, 'a.docx', zipBytes()))).toBe('complete')
  })

  it('catches a truncated file — the shape an interrupted write leaves', () => {
    const root = tempDir()
    const png = pngBytes(64, 64)
    expect(checkCompleteness(write(root, 'cut.png', png.subarray(0, png.length - 20)))).toBe('incomplete')
    const pdf = pdfBytes()
    expect(checkCompleteness(write(root, 'cut.pdf', pdf.subarray(0, pdf.length - 8)))).toBe('incomplete')
    const jpeg = jpegBytes()
    expect(checkCompleteness(write(root, 'cut.jpg', jpeg.subarray(0, jpeg.length - 2)))).toBe('incomplete')
  })

  it('catches a file whose bytes are not its format at all', () => {
    const root = tempDir()
    expect(checkCompleteness(write(root, 'fake.png', 'definitely not a png'))).toBe('incomplete')
  })

  it('is honest about formats it cannot verify', () => {
    const root = tempDir()
    expect(checkCompleteness(write(root, 'data.csv', 'a,b\n1,2\n'))).toBe('unverifiable')
    expect(checkCompleteness(write(root, 'clip.mp4', 'whatever'))).toBe('unverifiable')
  })
})
