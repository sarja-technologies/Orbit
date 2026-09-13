// The policy that turns "files that appeared during a turn" into the cards
// a user sees. Every rule here is a promise the conversation UI depends on.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { mentions, selectTurnOutputs, type TurnOutputCandidate } from '../../src/main/artifacts/turnOutputs'
import { bytesFor, pngBytes } from './fixtures/outputFiles'

const created: string[] = []
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-turn-')))
  created.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

let clock = 1000
function candidate(root: string, relative: string, overrides: Partial<TurnOutputCandidate> & { contents?: Buffer | string } = {}): TurnOutputCandidate {
  const filePath = path.join(root, relative)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const contents = overrides.contents ?? bytesFor(relative)
  fs.writeFileSync(filePath, contents)
  const { contents: _ignored, ...rest } = overrides
  return {
    filePath,
    root,
    displayName: path.basename(relative),
    byteSize: Buffer.byteLength(contents),
    modifiedMs: clock++,
    origin: 'workspace',
    created: true,
    ...rest
  }
}

const names = (outputs: Array<{ displayName: string }>): string[] => outputs.map((output) => output.displayName)

describe('what a completed turn surfaces', () => {
  it('surfaces deliverables and ignores source code', () => {
    const root = tempDir()
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: 'Done.',
      alreadyRegistered: [],
      candidates: [
        candidate(root, 'mountain.png'),
        candidate(root, 'report.pdf'),
        candidate(root, 'analysis.csv'),
        candidate(root, 'output.zip'),
        candidate(root, 'src/App.tsx'),
        candidate(root, 'src/index.ts'),
        candidate(root, 'package.json')
      ]
    })
    expect(names(selected)).toEqual(['mountain.png', 'report.pdf', 'analysis.csv', 'output.zip'])
  })

  it('surfaces an overwritten image as this turn’s output', () => {
    const root = tempDir()
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [],
      candidates: [candidate(root, 'sky.png', { created: false })]
    })
    expect(names(selected)).toEqual(['sky.png'])
  })

  it('surfaces a new .md or .txt only when the reply names it', () => {
    const root = tempDir()
    const base = [candidate(root, 'summary.md'), candidate(root, 'notes.txt')]
    expect(names(selectTurnOutputs({ ending: 'completed', finalText: 'I wrote `summary.md` for you.', alreadyRegistered: [], candidates: base }))).toEqual([
      'summary.md'
    ])
    expect(selectTurnOutputs({ ending: 'completed', finalText: 'Refactored the parser.', alreadyRegistered: [], candidates: base })).toEqual([])
  })

  it('never surfaces a new README or changelog, even when the reply names it', () => {
    // Live: a coding turn created README.md and listed it in its summary.
    const root = tempDir()
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: 'Added README.md and CHANGELOG.md, and wrote AGENTS.md.',
      alreadyRegistered: [],
      candidates: [candidate(root, 'README.md'), candidate(root, 'CHANGELOG.md'), candidate(root, 'AGENTS.md')]
    })
    expect(selected).toEqual([])
  })

  it('never surfaces an edited README, even when the reply names it', () => {
    const root = tempDir()
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: 'Updated README.md with the new flags.',
      alreadyRegistered: [],
      candidates: [candidate(root, 'README.md', { created: false })]
    })
    expect(selected).toEqual([])
  })

  it('drops a file whose bytes are not a finished instance of its format', () => {
    const root = tempDir()
    const png = pngBytes(32, 32)
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [],
      candidates: [candidate(root, 'broken.png', { contents: png.subarray(0, png.length - 16) }), candidate(root, 'good.png')]
    })
    expect(names(selected)).toEqual(['good.png'])
  })
})

describe('a turn that did not complete', () => {
  it('keeps provably finished files only', () => {
    const root = tempDir()
    const png = pngBytes(32, 32)
    for (const ending of ['cancelled', 'failed'] as const) {
      const selected = selectTurnOutputs({
        ending,
        finalText: '',
        alreadyRegistered: [],
        candidates: [
          candidate(root, `${ending}/finished.png`),
          candidate(root, `${ending}/half.png`, { contents: png.subarray(0, 40) }),
          // A CSV cannot prove it is finished, so a stopped turn does not
          // claim it.
          candidate(root, `${ending}/partial.csv`),
          candidate(root, `${ending}/notes.md`)
        ]
      })
      expect(names(selected), ending).toEqual(['finished.png'])
    }
  })
})

describe('one card per file', () => {
  it('collapses the same bytes in two places onto the workspace copy', () => {
    const workspace = tempDir()
    const brain = tempDir()
    const bytes = pngBytes(4, 4, 7)
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [],
      candidates: [
        candidate(brain, 'mountain_1789304888495.png', { contents: bytes, origin: 'provider-generated', displayName: 'mountain.png' }),
        candidate(workspace, 'assets/mountain.png', { contents: bytes })
      ]
    })
    expect(selected).toHaveLength(1)
    expect(selected[0]!.origin).toBe('workspace')
    expect(selected[0]!.filePath).toBe(path.join(workspace, 'assets', 'mountain.png'))
  })

  it('collapses a generated image the agent re-encoded into the project', () => {
    const workspace = tempDir()
    const brain = tempDir()
    const lookAlike = (a: string, b: string): boolean => path.basename(a).startsWith('mountain') && path.basename(b).startsWith('mountain')
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [],
      imagesLookAlike: lookAlike,
      candidates: [
        candidate(brain, 'mountain_1789306431271.jpg', { origin: 'provider-generated', displayName: 'mountain.jpg' }),
        candidate(workspace, 'mountain.png'),
        candidate(workspace, 'report.pdf')
      ]
    })
    expect(names(selected)).toEqual(['mountain.png', 'report.pdf'])
  })

  it('keeps a generated image that the project copy does not match', () => {
    const workspace = tempDir()
    const brain = tempDir()
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [],
      imagesLookAlike: () => false,
      candidates: [candidate(brain, 'sunset_1789306431271.jpg', { origin: 'provider-generated', displayName: 'sunset.jpg' }), candidate(workspace, 'chart.png')]
    })
    expect(names(selected)).toEqual(['sunset.jpg', 'chart.png'])
  })

  it('never drops a project image because it resembles another project image', () => {
    const workspace = tempDir()
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [],
      imagesLookAlike: () => true,
      candidates: [candidate(workspace, 'a.png', { contents: pngBytes(2, 2, 1) }), candidate(workspace, 'a@2x.png', { contents: pngBytes(4, 4, 1) })]
    })
    expect(selected).toHaveLength(2)
  })

  it('keeps two different images that happen to share a name', () => {
    const one = tempDir()
    const two = tempDir()
    const selected = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [],
      candidates: [candidate(one, 'mountain.png', { contents: pngBytes(2, 2, 1) }), candidate(two, 'mountain.png', { contents: pngBytes(2, 2, 2) })]
    })
    expect(selected).toHaveLength(2)
  })

  it('reports the same path once, however it was found', () => {
    const root = tempDir()
    const first = candidate(root, 'twice.png')
    const selected = selectTurnOutputs({ ending: 'completed', finalText: '', alreadyRegistered: [], candidates: [first, { ...first, modifiedMs: first.modifiedMs + 1 }] })
    expect(selected).toHaveLength(1)
  })

  it('does not re-register a provider output an earlier turn already has', () => {
    const brain = tempDir()
    const output = candidate(brain, 'peak_1789304888495.jpg', { origin: 'provider-generated' })
    const first = selectTurnOutputs({ ending: 'completed', finalText: '', alreadyRegistered: [], candidates: [output] })
    expect(first).toHaveLength(1)
    const again = selectTurnOutputs({
      ending: 'completed',
      finalText: '',
      alreadyRegistered: [{ originalPath: first[0]!.filePath, contentHash: first[0]!.contentHash }],
      candidates: [output]
    })
    expect(again).toEqual([])
  })
})

describe('naming a file in the reply', () => {
  it('matches the whole name, however it is quoted', () => {
    expect(mentions('Saved to report.md.', 'report.md')).toBe(true)
    expect(mentions('See [the report](./out/report.md)', 'report.md')).toBe(true)
    expect(mentions('`REPORT.MD` is ready', 'report.md')).toBe(true)
    expect(mentions('Écrit dans résumé.txt', 'résumé.txt')).toBe(true)
  })

  it('does not match a different file that contains the name', () => {
    expect(mentions('Updated old-report.md', 'report.md')).toBe(false)
    expect(mentions('Updated report.md5', 'report.md')).toBe(false)
    expect(mentions('', 'report.md')).toBe(false)
  })
})
