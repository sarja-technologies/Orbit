// Antigravity's image generation writes outside the workspace. These tests
// rebuild agy's real per-conversation folder layout, as captured live from
// agy 1.2.2 (docs/antigravity-transports.md, "Generated files"), and check
// Orbit finds exactly the generated media in it — and nothing a user
// uploaded, nothing agy keeps for itself, nothing from another turn.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { displayNameForGenerated, findConversationByPrompt, findGeneratedOutputs } from '../../src/main/runtime/providers/antigravity/generatedOutputs'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import { jpegBytes } from './fixtures/outputFiles'

const CONVERSATION = '7495881a-da77-4ae8-9a77-ebc8bc84598a'
const OTHER = '021ab0b0-0291-4497-82b0-9139d5a6bdc7'

let brain = ''
let started = 0

beforeEach(() => {
  brain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-brain-')))
  started = Date.now()
})

afterEach(() => {
  fs.rmSync(brain, { recursive: true, force: true })
})

function write(relative: string, contents: string | Buffer, mtimeMs = Date.now()): string {
  const full = path.join(brain, relative)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
  fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs))
  return full
}

/** agy's own transcript line for a user turn, in its real shape. */
function transcript(conversationId: string, prompt: string, createdAt = new Date()): void {
  const line = JSON.stringify({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>`
  })
  write(`${conversationId}/.system_generated/logs/transcript.jsonl`, `${line}\n`)
}

describe('finding what generate_image saved', () => {
  it('finds a generated image in the known conversation’s folder', () => {
    write(`${CONVERSATION}/small_mountain_1789304888495.jpg`, jpegBytes())

    const found = findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: 'Draw', startedAtMs: started }, brain)
    expect(found.map((output) => output.displayName)).toEqual(['small_mountain.jpg'])
    expect(found[0]!.root).toBe(path.join(brain, CONVERSATION))
    expect(found[0]!.origin).toBe('provider-generated')
  })

  it('ignores what the user uploaded, agy’s scratch media, its logs and its planning docs', () => {
    write(`${CONVERSATION}/.user_uploaded/uploaded_media_1789006158457.png`, 'user')
    write(`${CONVERSATION}/.tempmediaStorage/media_1789006345888.png`, 'temp')
    write(`${CONVERSATION}/.system_generated/steps/2/output.txt`, 'Generated image is saved at …')
    write(`${CONVERSATION}/implementation_plan.md`, '# plan')
    write(`${CONVERSATION}/api_contract.md.metadata.json`, '{}')

    expect(findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: 'Draw', startedAtMs: started }, brain)).toEqual([])
  })

  it('ignores images an earlier turn generated', () => {
    write(`${CONVERSATION}/yesterday_1784458538638.jpg`, jpegBytes(), started - 60_000)
    write(`${CONVERSATION}/today_1789304888495.jpg`, jpegBytes())

    const found = findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: 'Draw', startedAtMs: started }, brain)
    expect(found.map((output) => output.displayName)).toEqual(['today.jpg'])
  })

  it('never looks at another conversation’s folder', () => {
    write(`${OTHER}/someone_else_1789304888495.jpg`, jpegBytes())
    transcript(OTHER, 'A completely different request')

    expect(findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: 'Draw a mountain', startedAtMs: started }, brain)).toEqual([])
  })

  it('refuses a conversation id that is not agy’s — no path can be smuggled in', () => {
    write('escape/evil_1789304888495.jpg', jpegBytes())
    for (const id of ['../escape', 'escape', `${CONVERSATION}/../escape`, '/etc']) {
      expect(findGeneratedOutputs({ conversationId: 'c', nativeConversationId: id, prompt: '', startedAtMs: started }, brain), id).toEqual([])
    }
  })

  it('does not follow a generated file that is a symlink', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-outside-')))
    try {
      fs.writeFileSync(path.join(outside, 'secret.jpg'), jpegBytes())
      fs.mkdirSync(path.join(brain, CONVERSATION), { recursive: true })
      fs.symlinkSync(path.join(outside, 'secret.jpg'), path.join(brain, CONVERSATION, 'link_1789304888495.jpg'))
      expect(findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: '', startedAtMs: started }, brain)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('returns nothing when agy has no brain folder on this machine', () => {
    expect(findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: 'x', startedAtMs: started }, path.join(brain, 'missing'))).toEqual([])
  })
})

describe('a first interactive turn, before any conversation id exists', () => {
  it('finds the conversation by the prompt agy recorded for this turn', () => {
    transcript(OTHER, 'Summarise the changelog')
    transcript(CONVERSATION, 'Create a 1024×1024 PNG of a mountain and show it to me.')
    write(`${CONVERSATION}/mountain_1789304888495.jpg`, jpegBytes())

    expect(findConversationByPrompt(brain, 'Create a 1024×1024 PNG of a mountain and show it to me.', started)).toBe(CONVERSATION)
    const found = findGeneratedOutputs({ conversationId: 'c', nativeConversationId: null, prompt: 'Create a 1024×1024 PNG of a mountain and show it to me.', startedAtMs: started }, brain)
    expect(found.map((output) => output.displayName)).toEqual(['mountain.jpg'])
  })

  it('tolerates whitespace and a hint appended after the prompt', () => {
    transcript(CONVERSATION, 'Draw   a\nmountain\n\nAttached Orbit files (inspect these managed paths):\n- a.png: /x/a.png')
    expect(findConversationByPrompt(brain, 'Draw a mountain', started)).toBe(CONVERSATION)
  })

  it('does not match the same words sent in an earlier turn', () => {
    transcript(CONVERSATION, 'Draw a mountain', new Date(started - 10 * 60_000))
    expect(findConversationByPrompt(brain, 'Draw a mountain', started)).toBeNull()
  })
})

describe('the provider', () => {
  it('reads its own brain folder and never throws', () => {
    write(`${CONVERSATION}/peak_1789304888495.jpg`, jpegBytes())
    const provider = new AntigravityProvider(undefined, undefined, () => brain)
    expect(provider.findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: '', startedAtMs: started })).toHaveLength(1)

    const broken = new AntigravityProvider(undefined, undefined, () => {
      throw new Error('no home directory')
    })
    expect(broken.findGeneratedOutputs({ conversationId: 'c', nativeConversationId: CONVERSATION, prompt: '', startedAtMs: started })).toEqual([])
  })

  it('shows the name the model chose, without agy’s timestamp', () => {
    expect(displayNameForGenerated('small_mountain_1789304888495.jpg')).toBe('small_mountain.jpg')
    expect(displayNameForGenerated('logo_v2.png')).toBe('logo_v2.png')
  })
})
