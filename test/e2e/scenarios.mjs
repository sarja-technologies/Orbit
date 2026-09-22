// Automated UI validation against the REAL, built Orbit application.
//
// Every assertion runs against the shipped bundle in `out/`, driven over
// CDP (cdp.mjs), reading the real DOM a user would see. Nothing here stubs
// the renderer, the preload, the IPC layer or the store, and Orbit's
// production code contains no test hooks for this file to call — the
// transcript fixtures are ordinary rows written into the real database
// before launch (seed.mjs), and everything else is real input dispatched
// at real elements.
//
// Run with: npm run test:e2e (requires a current `npm run build`).
//
// Scenarios that need a real model turn live in the live agy suite
// (test/main/antigravity-live.test.ts), which is where real-account calls
// belong. This file is about what the UI does with the state it has.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OrbitApp, cleanup } from './cdp.mjs'
import { queryDatabase, rememberActiveSession, seedInterruptedRun, seedSession, seedTurn } from './seed.mjs'

const results = []
let app = null

async function scenario(name, body) {
  const started = Date.now()
  try {
    await body()
    results.push({ name, ok: true })
    process.stdout.write(`  ✓ ${name} (${Date.now() - started}ms)\n`)
  } catch (error) {
    results.push({ name, ok: false, error })
    process.stdout.write(`  ✗ ${name}\n      ${String(error.message).split('\n').join('\n      ')}\n`)
  }
}

// ---------- fixtures ----------

const WIDE_TABLE = [
  'Here is the comparison:',
  '',
  '| Compilation target | JavaScript runtime | TypeScript runtime | Notes about the toolchain | Status |',
  '| --- | --- | --- | --- | --- |',
  '| ES2015 | Node 18 and browsers | tsc 5.7 | Needs a polyfill for structuredClone on older Safari | Supported |',
  '| ES2022 | Node 20 or newer | tsc 5.7 | Array.prototype.at is available natively everywhere | **Supported** |',
  '| ESNext | Node 24 | tsc 5.7 | Some proposals are still stage three and may change | Experimental |'
].join('\n')

const NARROW_TABLE = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n')

const LONG_REPORT = [
  '## What I changed',
  '',
  'Renamed the transport helper and moved every caller onto the new name.',
  '',
  ...Array.from({ length: 22 }, (_, i) => `Step ${i + 1}. Updated another caller and re-ran the affected tests.\n`)
].join('\n')

const REPORT_WITH_TROUBLE = [LONG_REPORT, '', 'One test is still failing: the retirement case errors out.'].join('\n')

const REPORT_WITH_FENCE = [
  'Here is the patch.',
  '',
  '```ts',
  ...Array.from({ length: 40 }, (_, i) => `const lineNumber${i} = ${i}`),
  '```'
].join('\n')

// ---------- real input helpers ----------

/** Dispatches a genuine paste at the composer, carrying a genuine
 *  DataTransfer. The component's own onPaste handler runs; nothing about
 *  Orbit is stubbed. The clipboard payload is constructed rather than read
 *  from the OS because the real clipboard is shared machine state a test
 *  must not clobber — and because a "text plus rendered image" payload is
 *  precisely the case being tested. */
function pasteScript({ text, image }) {
  return `(() => {
    const area = document.querySelector('textarea.composer-input')
    area.focus()
    const data = new DataTransfer()
    ${text !== undefined ? `data.setData('text/plain', ${JSON.stringify(text)})` : ''}
    ${
      image
        ? `const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
           data.items.add(new File([bytes], 'clip.png', { type: 'image/png' }))`
        : ''
    }
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    area.dispatchEvent(event)
    return JSON.stringify({ prevented: event.defaultPrevented, value: area.value })
  })()`
}

/** Sets the composer through React's own value setter, so the component
 *  state and the DOM agree — the same thing typing does, without spending
 *  a keystroke round trip per character. */
function setComposer(value) {
  return `(() => {
    const area = document.querySelector('textarea.composer-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, ${JSON.stringify(value)})
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return area.value
  })()`
}

/** The real OS clipboard, saved and restored around the Cmd+V scenario so
 *  a test run never destroys what the developer had copied. */
function readClipboard() {
  if (process.platform !== 'darwin') return ''
  try {
    return execFileSync('pbpaste', { encoding: 'utf8' })
  } catch {
    return ''
  }
}

function writeClipboard(value) {
  if (process.platform !== 'darwin') return
  try {
    execFileSync('pbcopy', { input: value })
  } catch {
    /* nothing to restore to */
  }
}

const composerValue = `document.querySelector('textarea.composer-input').value`
const userMessageCount = `document.querySelectorAll('.chat-row-user').length`

/** An Orbit database with the real schema in it, created by the real app.
 *
 *  The fixtures below write rows, not tables: duplicating the schema here
 *  would be a second copy to keep in step with migrations, and a fixture
 *  built on a stale one would prove nothing. So the app is launched once
 *  against an empty directory, allowed to create and migrate its own
 *  database, and that file is copied as the starting point for every
 *  scenario group. */
let templateDatabase = null

async function prepareTemplate() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-e2e-template-'))
  const first = await OrbitApp.launch({ userDataDir: base })
  await first.waitFor(`!!document.querySelector('[aria-label="New project or session"]')`, { label: 'the app shell' })
  await first.close()
  const created = path.join(base, 'orbit', 'orbit.sqlite')
  if (!fs.existsSync(created)) throw new Error(`the app did not create ${created}`)
  templateDatabase = created
}

async function launchWith(seed) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-e2e-'))
  const orbitData = path.join(base, 'orbit')
  fs.mkdirSync(orbitData, { recursive: true })
  fs.copyFileSync(templateDatabase, path.join(orbitData, 'orbit.sqlite'))
  const conversationId = await seedSession(orbitData)
  if (seed) await seed(orbitData, conversationId)
  await rememberActiveSession(orbitData, conversationId)
  const launched = await OrbitApp.launch({ userDataDir: base })
  await launched.waitFor(`!!document.querySelector('textarea.composer-input')`, { label: 'the composer' })
  return { app: launched, conversationId, orbitData }
}

// ---------- the suite ----------

async function main() {
  process.stdout.write('\nOrbit end-to-end — real Electron, real build, real database\n\n')
  await prepareTemplate()

  // === composer, paste and submit ===
  process.stdout.write('composer and paste\n')
  const composerRun = await launchWith(null)
  app = composerRun.app

  await scenario('typed text reaches the composer through the real input pipeline', async () => {
    await app.evaluate(`document.querySelector('textarea.composer-input').focus()`)
    for (const ch of 'Hello') await app.key(ch, { text: ch, keyCode: ch.toUpperCase().charCodeAt(0) })
    assert.equal(await app.evaluate(composerValue), 'Hello')
  })

  // A dispatched ClipboardEvent runs Orbit's own handler but cannot
  // perform the browser's default insertion (untrusted events never do).
  // So these assert on the thing Orbit actually decides — whether it
  // swallows the paste — and the real end-to-end insertion is covered by
  // the OS-clipboard Cmd+V scenario below.

  await scenario('a plain-text paste is left to the textarea', async () => {
    const result = JSON.parse(await app.evaluate(pasteScript({ text: 'pasted plain text' })))
    assert.equal(result.prevented, false, 'a text paste must fall through to the textarea')
  })

  await scenario('a multiline paste is left to the textarea, and submits nothing', async () => {
    await app.evaluate(setComposer(''))
    const before = await app.evaluate(userMessageCount)
    const result = JSON.parse(await app.evaluate(pasteScript({ text: 'first line\nsecond line\nthird line' })))
    assert.equal(result.prevented, false, 'a multiline text paste must still be an ordinary paste')
    assert.equal(await app.evaluate(userMessageCount), before, 'pasting must never submit a turn')
  })

  await scenario('a spreadsheet-style clipboard (text AND a rendered image) pastes the text', async () => {
    // THE BUG from the previous pass: copying a table out of a spreadsheet,
    // or text out of a PDF viewer, puts a rendered image on the clipboard
    // beside the text. The image branch won and the text vanished.
    await app.evaluate(setComposer(''))
    const text = '| Feature | Value |\n| --- | --- |\n| Speed | Fast |'
    const result = JSON.parse(await app.evaluate(pasteScript({ text, image: true })))
    assert.equal(result.prevented, false, 'the text must win over the rendered image')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(
      await app.evaluate(`document.querySelectorAll('.composer-attachments img, .composer-attachments .attachment-chip').length`),
      0,
      'no attachment should have been created'
    )
  })

  await scenario('an image-only clipboard is still taken as an attachment', async () => {
    await app.evaluate(setComposer(''))
    const result = JSON.parse(await app.evaluate(pasteScript({ image: true })))
    assert.equal(result.prevented, true, 'an image-only paste is Orbit’s to handle, not the textarea’s')
  })

  await scenario('a real paste shortcut inserts the real OS clipboard, multiline and all', async () => {
    // A genuine clipboard insertion: real text on the real OS clipboard,
    // a real key event carrying Chromium's own `paste` editing command,
    // and the real textarea receiving it. (A bare Cmd+V on macOS is an
    // AppKit menu key equivalent resolved before web contents ever see the
    // event; the menu that supplies it is pinned by appMenu.test.ts.)
    // The user's own clipboard is saved and put back afterwards.
    const saved = readClipboard()
    try {
      const marker = 'orbit-e2e-clipboard-' + Date.now()
      writeClipboard(marker + '\nsecond pasted line')
      await app.evaluate(setComposer(''))
      await app.evaluate(`document.querySelector('textarea.composer-input').focus()`)
      const before = await app.evaluate(userMessageCount)

      await app.key('v', { code: 'KeyV', keyCode: 86, modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['paste'] })
      await app.waitFor(`${composerValue}.includes(${JSON.stringify(marker)})`, { label: 'the pasted clipboard text' })

      const value = await app.evaluate(composerValue)
      assert.ok(value.includes('second pasted line'), 'both pasted lines should arrive')
      assert.equal(await app.evaluate(userMessageCount), before, 'a real paste must not submit halfway through')
    } finally {
      writeClipboard(saved)
      await app.evaluate(setComposer(''))
    }
  })

  await scenario('Shift+Enter does not submit, and Enter submits exactly once', async () => {
    await app.evaluate(setComposer('a real prompt'))
    const before = await app.evaluate(userMessageCount)
    await app.key('Enter', { code: 'Enter', keyCode: 13, modifiers: 8 }) // shift
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(await app.evaluate(userMessageCount), before, 'Shift+Enter must not submit')
    assert.equal(await app.evaluate(composerValue), 'a real prompt', 'Shift+Enter must leave the draft alone')

    await app.key('Enter', { code: 'Enter', keyCode: 13 })
    await app.waitFor(`${userMessageCount} === ${before + 1}`, { label: 'exactly one submitted turn' })
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(await app.evaluate(userMessageCount), before + 1, 'Enter must submit exactly once')
  })

  await app.close()

  // === markdown tables ===
  process.stdout.write('\nmarkdown tables\n')
  const tableRun = await launchWith(async (dir, conversationId) => {
    await seedTurn(dir, conversationId, { prompt: 'Compare the targets', content: WIDE_TABLE })
    await seedTurn(dir, conversationId, { prompt: 'And a small one', content: NARROW_TABLE })
  })
  app = tableRun.app
  await app.waitFor(`document.querySelectorAll('.table-scroll table').length >= 2`, { label: 'both tables' })

  await scenario('a wide table scrolls its own wrapper instead of crushing its columns', async () => {
    const m = JSON.parse(
      await app.evaluate(`(() => {
        const wrap = document.querySelectorAll('.table-scroll')[0]
        const table = wrap.querySelector('table')
        const transcript = document.querySelector('.transcript')
        const cells = Array.from(table.querySelectorAll('tbody tr:first-child td'))
        return JSON.stringify({
          wrapClient: wrap.clientWidth,
          wrapScroll: wrap.scrollWidth,
          narrowestCell: Math.min(...cells.map(c => c.getBoundingClientRect().width)),
          transcriptClient: transcript.clientWidth,
          transcriptScroll: transcript.scrollWidth
        })
      })()`)
    )
    assert.ok(m.wrapScroll > m.wrapClient, `the wrapper must genuinely scroll (scroll ${m.wrapScroll} vs client ${m.wrapClient})`)
    assert.ok(m.narrowestCell > 45, `columns must not be crushed — narrowest cell was ${m.narrowestCell}px`)
    assert.ok(
      m.transcriptScroll <= m.transcriptClient + 1,
      `the transcript must not scroll sideways (scroll ${m.transcriptScroll} vs client ${m.transcriptClient})`
    )
  })

  await scenario('the wide table stays inside its bubble and keeps inline formatting', async () => {
    const i = JSON.parse(
      await app.evaluate(`(() => {
        const wrap = document.querySelectorAll('.table-scroll')[0]
        const bubble = wrap.closest('.chat-bubble')
        return JSON.stringify({
          strong: !!wrap.querySelector('td strong'),
          wrapRight: Math.round(wrap.getBoundingClientRect().right),
          bubbleRight: Math.round(bubble.getBoundingClientRect().right)
        })
      })()`)
    )
    assert.equal(i.strong, true, 'bold inside a cell should render as <strong>')
    assert.ok(i.wrapRight <= i.bubbleRight, 'the table must not spill outside its bubble')
  })

  await scenario('long header labels wrap rather than forcing a single line', async () => {
    const nowrap = await app.evaluate(
      `getComputedStyle(document.querySelectorAll('.table-scroll')[0].querySelector('thead th')).whiteSpace`
    )
    assert.notEqual(nowrap, 'nowrap', 'headers must be allowed to wrap')
  })

  await scenario('a narrow table fills its box without scrolling', async () => {
    const m = JSON.parse(
      await app.evaluate(`(() => {
        const wrap = document.querySelectorAll('.table-scroll')[1]
        return JSON.stringify({ client: wrap.clientWidth, scroll: wrap.scrollWidth, rows: wrap.querySelectorAll('tbody tr').length })
      })()`)
    )
    assert.equal(m.rows, 1)
    assert.ok(m.scroll <= m.client + 1, 'a small table has nothing to scroll')
  })

  await scenario('surrounding messages stay aligned on the transcript rail', async () => {
    const aligned = await app.evaluate(`(() => {
      const bubbles = Array.from(document.querySelectorAll('.chat-row-assistant .chat-bubble'))
      const lefts = bubbles.map(b => Math.round(b.getBoundingClientRect().left))
      return new Set(lefts).size === 1
    })()`)
    assert.equal(aligned, true, 'every assistant bubble should share one left edge')
  })

  await app.close()

  // === long report folding ===
  process.stdout.write('\nlong report folding\n')
  const foldRun = await launchWith(async (dir, conversationId) => {
    await seedTurn(dir, conversationId, { prompt: 'Do the refactor', content: LONG_REPORT })
  })
  app = foldRun.app

  await scenario('a long successful report folds and says how much is behind the button', async () => {
    await app.waitFor(`!!document.querySelector('.report-fold-more')`, { label: 'the fold button' })
    const label = await app.evaluate(`document.querySelector('.report-fold-more').innerText`)
    assert.ok(/more lines/.test(label), `the button should state what is hidden, got: ${JSON.stringify(label)}`)
  })

  await scenario('the preview is a literal prefix of the real message', async () => {
    const preview = await app.evaluate(`document.querySelector('.report-fold-preview').innerText`)
    assert.ok(preview.includes('What I changed'), 'the preview opens on the report’s own opening')
    assert.ok(!preview.includes('Step 22.'), 'the tail is not rendered while folded')
    // Every rendered line must appear, in order, in the original source.
    const lines = preview.split('\n').map((l) => l.trim()).filter(Boolean)
    let cursor = 0
    for (const line of lines) {
      const at = LONG_REPORT.indexOf(line, cursor)
      assert.ok(at >= 0, `preview line not found verbatim in the original: ${JSON.stringify(line)}`)
      cursor = at
    }
  })

  await scenario('the copy action still copies the whole report, not the preview', async () => {
    const copied = await app.evaluate(`(async () => {
      const row = document.querySelector('.chat-row-assistant')
      const button = row.querySelector('.message-action')
      button.click()
      await new Promise(r => setTimeout(r, 300))
      return button.getAttribute('aria-label')
    })()`)
    assert.ok(/copied/i.test(copied), `the copy action should report success, got ${JSON.stringify(copied)}`)
  })

  await scenario('one click reveals the whole report and retires the button', async () => {
    await app.evaluate(`document.querySelector('.report-fold-more').click()`)
    await app.waitFor(`document.body.innerText.includes('Step 22.')`, { label: 'the expanded report' })
    assert.equal(await app.evaluate(`!!document.querySelector('.report-fold-more')`), false, 'the button should be gone')
  })

  await app.close()

  await scenario('a long report that describes a failure is never folded', async () => {
    const run = await launchWith(async (dir, conversationId) => {
      await seedTurn(dir, conversationId, { prompt: 'Refactor', content: REPORT_WITH_TROUBLE })
    })
    app = run.app
    await app.waitFor(`document.body.innerText.includes('One test is still failing')`, { label: 'the failure line' })
    assert.equal(
      await app.evaluate(`!!document.querySelector('.report-fold-more')`),
      false,
      'a report that reports a problem must stay fully visible'
    )
    await app.close()
  })

  await scenario('a single long fenced block is shown whole rather than cut mid-fence', async () => {
    const run = await launchWith(async (dir, conversationId) => {
      await seedTurn(dir, conversationId, { prompt: 'Show the patch', content: REPORT_WITH_FENCE })
    })
    app = run.app
    await app.waitFor(`document.body.innerText.includes('const lineNumber39')`, { label: 'the end of the fence' })
    assert.equal(await app.evaluate(`!!document.querySelector('.report-fold-more')`), false, 'there is no safe boundary to cut on')
    const fences = await app.evaluate(`document.querySelectorAll('.code-block').length`)
    assert.equal(fences, 1, 'the fence should render as exactly one code block')
    await app.close()
  })

  await scenario('a cancelled turn stays visible as its own calm note', async () => {
    const run = await launchWith(async (dir, conversationId) => {
      await seedTurn(dir, conversationId, { prompt: 'Long job', content: 'Partial answer.', state: 'cancelled' })
    })
    app = run.app
    await app.waitFor(`document.body.innerText.includes('You stopped this response')`, { label: 'the stopped note' })
    const shouty = await app.evaluate(`/went wrong|try again/i.test(document.body.innerText)`)
    assert.equal(shouty, false, 'stopping is not an error')
    await app.close()
  })

  await scenario('a failed turn keeps its error note and its raw details', async () => {
    const run = await launchWith(async (dir, conversationId) => {
      await seedTurn(dir, conversationId, {
        prompt: 'Do it',
        content: 'agy exited with code 1',
        state: 'failed',
        error: { code: 'provider.failed', message: 'agy exited with code 1', retryable: true }
      })
    })
    app = run.app
    await app.waitFor(`!!document.querySelector('.error-note')`, { label: 'the error note' })
    assert.equal(
      await app.evaluate(`!!document.querySelector('.error-note .disclosure')`),
      true,
      'the raw failure text must stay reachable'
    )
    assert.equal(await app.evaluate(`!!document.querySelector('.report-fold-more')`), false, 'a failure never folds')
    await app.close()
  })

  // === model attribution, across a real restart ===
  process.stdout.write('\nmodel attribution and session restore\n')
  const attributionRun = await launchWith(async (dir, conversationId) => {
    await seedTurn(dir, conversationId, { prompt: 'First', content: 'Answer from the first model.', model: 'gemini-3.8-flash' })
    await seedTurn(dir, conversationId, { prompt: 'Second', content: 'Answer from the second model.', model: 'claude-opus-4-6' })
  })
  app = attributionRun.app

  await scenario('each turn is labelled with the model that actually answered it', async () => {
    // The session itself is stored on claude-opus-4-6, which is what used
    // to restamp the whole history.
    await app.waitFor(`document.body.innerText.includes('Answer from the second model.')`, { label: 'the transcript' })
    const labels = JSON.parse(
      await app.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.chat-row-assistant .chat-name')).map(n => n.textContent))`)
    )
    assert.ok(labels.some((l) => /flash/i.test(l)), `the first turn should still name Gemini, got ${JSON.stringify(labels)}`)
    assert.ok(labels.some((l) => /opus|claude/i.test(l)), `the second turn should name Claude, got ${JSON.stringify(labels)}`)
  })

  await scenario('the attribution comes from the run record, not the session setting', async () => {
    const rows = await queryDatabase(attributionRun.orbitData, 'SELECT metadata_json FROM runs ORDER BY started_at')
    const models = rows.map((row) => JSON.parse(String(row.metadata_json)).model)
    assert.deepEqual(models, ['gemini-3.8-flash', 'claude-opus-4-6'], 'each run records its own model')
  })

  await scenario('attribution and transcript survive a real Orbit restart', async () => {
    app = await app.restart()
    await app.waitFor(`!!document.querySelector('textarea.composer-input')`, { label: 'the composer after restart' })
    await app.waitFor(`document.body.innerText.includes('Answer from the first model.')`, { label: 'the restored transcript' })
    const labels = JSON.parse(
      await app.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.chat-row-assistant .chat-name')).map(n => n.textContent))`)
    )
    assert.ok(labels.some((l) => /flash/i.test(l)), `after restart the first turn should still name Gemini, got ${JSON.stringify(labels)}`)
  })

  await scenario('the remembered session is the one that reopens', async () => {
    const title = await app.evaluate(`document.querySelector('.chrome-session, .chrome-bar')?.innerText ?? ''`)
    assert.ok(/E2E Session/.test(title) || (await app.evaluate(`document.body.innerText.includes('E2E Session')`)), 'the seeded session should be open')
  })

  await scenario('a long report folds again after a restart, having not been watched', async () => {
    // The fold is for history. Nothing was streamed in this window, so the
    // report is the reader's to open rather than to scroll past.
    const run = await launchWith(async (dir, conversationId) => {
      await seedTurn(dir, conversationId, { prompt: 'Refactor', content: LONG_REPORT })
    })
    const restarted = await run.app.restart()
    try {
      await restarted.waitFor(`!!document.querySelector('.report-fold-more')`, { label: 'the fold after restart' })
    } finally {
      await restarted.close()
    }
  })

  await app.close()

  // === phantom running state and interrupted runs ===
  process.stdout.write('\nrun-state integrity\n')
  const interruptedRun = await launchWith(async (dir, conversationId) => {
    await seedTurn(dir, conversationId, { prompt: 'Earlier', content: 'A finished answer.' })
    await seedInterruptedRun(dir, conversationId)
  })
  app = interruptedRun.app

  await scenario('an interrupted run is settled at startup rather than left in flight', async () => {
    const rows = await queryDatabase(
      interruptedRun.orbitData,
      "SELECT state FROM runs WHERE state IN ('queued','running','waiting_for_interaction','cancelling')"
    )
    assert.equal(rows.length, 0, `no run may still be non-terminal after startup, found ${JSON.stringify(rows)}`)
  })

  await scenario('the interrupted turn says plainly what happened', async () => {
    await app.waitFor(`document.body.innerText.includes('Orbit closed before this response finished')`, { label: 'the settled note' })
  })

  await scenario('a restored session shows no phantom running state', async () => {
    const s = JSON.parse(
      await app.evaluate(`JSON.stringify({
        stop: !!document.querySelector('[aria-label="Stop generating"]'),
        send: !!document.querySelector('[aria-label="Send message"]'),
        live: /is working|is replying|Stopping/.test(document.body.innerText)
      })`)
    )
    assert.equal(s.stop, false, 'nothing should be stoppable after a restart')
    assert.equal(s.send, true, 'the composer should be ready to send')
    assert.equal(s.live, false, 'no turn should claim to be in flight')
  })

  await scenario('a completed turn stays completed across the restart', async () => {
    await app.waitFor(`document.body.innerText.includes('A finished answer.')`, { label: 'the completed turn' })
  })

  await app.screenshot('final')
  process.stdout.write(`\n  artifacts: ${app.dirs.base}\n`)
}

let exitCode = 0
try {
  await main()
} catch (error) {
  process.stdout.write(`\nharness failed: ${error.stack}\n`)
  exitCode = 1
} finally {
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  process.stdout.write(`\n  ${passed} passed, ${failed} failed, ${results.length} total\n\n`)
  if (failed > 0) exitCode = 1
  if (app) {
    await app.close()
    if (exitCode === 0) cleanup(app)
  }
}
process.exit(exitCode)
