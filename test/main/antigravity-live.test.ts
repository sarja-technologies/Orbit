import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

// Explicitly opt-in: this calls the user's signed-in Antigravity account.
// It proves the actual Orbit provider path, while keeping normal unit tests
// deterministic and credential-free.
const live = process.env.ORBIT_REAL_AGY === '1'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('AntigravityProvider live integration', () => {
  it.runIf(live)('uses the installed signed-in agy runtime without SDK credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-live-'))
    dirs.push(dir)
    const provider = new AntigravityProvider()
    const result = await run(provider, input(dir, 'Reply with exactly: ORBIT_AGENTDOCK_AGY_OK'))
    expect(result.text.trim()).toBe('ORBIT_AGENTDOCK_AGY_OK')
    expect(result.nativeConversationId).toMatch(/^[0-9a-f-]{20,}$/i)
    await provider.shutdown()
  }, 120_000)
})

function input(workspacePath: string, prompt: string): ProviderSendInput {
  return { projectId: 'project', conversationId: 'conversation', runId: `run-${Date.now()}`, prompt, nativeConversationId: null, workspacePath, saveDir: workspacePath, attachments: [], referencedArtifacts: [] }
}
function run(provider: AntigravityProvider, value: ProviderSendInput): Promise<{ text: string; nativeConversationId: string | null }> {
  return new Promise((resolve, reject) => {
    let text = ''; let nativeConversationId: string | null = null
    const onEvent = (event: RuntimeEvent) => {
      if (event.type === 'run.started') nativeConversationId = event.nativeConversationId ?? null
      if (event.type === 'text.delta') text += event.delta
      if (event.type === 'run.completed') resolve({ text: event.finalText || text, nativeConversationId: event.nativeConversationId ?? nativeConversationId })
      if (event.type === 'run.failed') reject(new Error(event.error.message))
      if (event.type === 'run.cancelled') reject(new Error('unexpected cancellation'))
    }
    void provider.sendMessage(value, onEvent).catch(reject)
  })
}
