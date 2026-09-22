// A minimal Chrome DevTools Protocol client for driving the real, built
// Orbit application.
//
// Deliberately dependency-free. Node 22+ ships a global `WebSocket`, and
// Electron already speaks CDP when given `--remote-debugging-port`, so the
// whole harness is the standard library plus the app itself. Adding
// Playwright would pull a browser-automation stack into a repo whose only
// automation need is "open the real app and look at the real DOM".
//
// Everything here drives the SHIPPED build (`out/`), against a throwaway
// user-data directory, so a run can never touch the developer's own Orbit
// data — and never inherits state from a previous run.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Resolves once the app prints the DevTools endpoint, or rejects if it
 *  exits first — an app that dies at launch must fail loudly rather than
 *  hang until the suite times out. */
function waitForEndpoint(child, log) {
  return new Promise((resolve, reject) => {
    let settled = false
    const onChunk = (chunk) => {
      const text = String(chunk)
      log.push(text)
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text)
      if (match && !settled) {
        settled = true
        resolve(match[1])
      }
    }
    child.stderr.on('data', onChunk)
    child.stdout.on('data', onChunk)
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      reject(new Error(`Orbit exited before DevTools came up (code ${code}).\n${log.join('')}`))
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Orbit never announced a DevTools endpoint.\n${log.join('')}`))
    }, 60_000)
  })
}

class Connection {
  #socket
  #nextId = 1
  #pending = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = this.#pending.get(message.id)
      if (!waiter) return
      this.#pending.delete(message.id)
      if (message.error) waiter.reject(new Error(`${message.error.message} (${JSON.stringify(message.params ?? {})})`))
      else waiter.resolve(message.result)
    })
  }

  static async open(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      // A connect that neither opens nor errors would otherwise hang the
      // whole suite with no output at all.
      const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), 20_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`could not connect to ${url}`)) }, { once: true })
    })
    return new Connection(socket)
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.#socket.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (!this.#pending.has(id)) return
        this.#pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 60_000)
    })
  }

  close() {
    try {
      this.#socket.close()
    } catch {
      /* already gone */
    }
  }
}

/** The real application, under automation. */
export class OrbitApp {
  constructor(child, connection, dirs, log) {
    this.child = child
    this.cdp = connection
    this.dirs = dirs
    this.log = log
  }

  /** Launches the built app. `env` is merged over the harness defaults, so
   *  a scenario can point Orbit at a prepared workspace. */
  static async launch({ env = {}, userDataDir } = {}) {
    const base = userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-e2e-'))
    const orbitData = path.join(base, 'orbit')
    const chromeData = path.join(base, 'chrome')
    fs.mkdirSync(orbitData, { recursive: true })
    fs.mkdirSync(chromeData, { recursive: true })

    const log = []
    const child = spawn(
      path.join(ROOT, 'node_modules/.bin/electron'),
      [
        ROOT,
        '--no-sandbox',
        '--remote-debugging-port=0',
        // Isolates Electron's own single-instance lock and profile, so a
        // run cannot be refused by (or interfere with) a developer's open
        // copy of Orbit.
        `--user-data-dir=${chromeData}`
      ],
      {
        cwd: ROOT,
        env: { ...process.env, ORBIT_USER_DATA_DIR: orbitData, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // `node_modules/.bin/electron` is a Node launcher that spawns the
        // real Electron binary as a child. Signalling only the launcher
        // leaves Electron running and orphaned — which then holds a window
        // open and eats the machine over a long suite. Its own process
        // group makes the whole tree signallable at once.
        detached: true
      }
    )

    const endpoint = await waitForEndpoint(child, log)
    const browser = await Connection.open(endpoint)

    // Attach to the renderer, not the browser target: every DOM call below
    // is scoped to that session.
    const { targetInfos } = await browser.send('Target.getTargets')
    const page = targetInfos.find((target) => target.type === 'page')
    if (!page) throw new Error(`no renderer target among ${targetInfos.map((t) => t.type).join(', ')}`)
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })

    const app = new OrbitApp(child, browser, { base, orbitData, chromeData }, log)
    app.sessionId = sessionId
    await browser.send('Runtime.enable', {}, sessionId)
    await browser.send('Page.enable', {}, sessionId)
    return app
  }

  /** Evaluates an expression in the renderer and returns its value.
   *  Promises are awaited, so a scenario can await app-side work. */
  async evaluate(expression) {
    const result = await this.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      this.sessionId
    )
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      throw new Error(`renderer threw: ${detail.exception?.description ?? detail.text}`)
    }
    return result.result.value
  }

  /** Polls `expression` until it is truthy. Returns its value. */
  async waitFor(expression, { timeout = 30_000, label = expression } = {}) {
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      last = await this.evaluate(expression)
      if (last) return last
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`timed out waiting for: ${label}`)
  }

  /** A real key press through the input pipeline, not a synthetic React
   *  event — this is what makes "Enter submits" a genuine assertion. */
  async key(key, { code, keyCode, modifiers = 0, text, commands } = {}) {
    const base = { modifiers, key, code: code ?? key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
    // `commands` is Chromium's own editing-command channel — the same one
    // the browser resolves a shortcut into before the editor acts on it.
    // It is the only way to drive a REAL clipboard insertion from here: on
    // macOS a bare Cmd+V is an AppKit menu key equivalent, resolved before
    // the event reaches web contents at all, and CDP input is injected
    // after that point. The application menu that supplies that equivalent
    // is pinned separately by test/main/appMenu.test.ts.
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      { type: text ? 'keyDown' : 'rawKeyDown', text, ...(commands ? { commands } : {}), ...base },
      this.sessionId
    )
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId)
  }

  async screenshot(name) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    const file = path.join(this.dirs.base, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  /** Stops the app and waits for the process to actually be gone, so the
   *  next launch cannot race its predecessor's lock. */
  async close() {
    this.cdp.close()
    if (this.child.exitCode !== null) return
    const exited = new Promise((resolve) => this.child.once('exit', resolve))
    this.#signalGroup('SIGTERM')
    const force = setTimeout(() => this.#signalGroup('SIGKILL'), 5000)
    // Bounded: a tree that refuses even SIGKILL must not wedge the suite.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 12_000))])
    clearTimeout(force)
    this.#signalGroup('SIGKILL')
  }

  /** Signals the launcher AND the real Electron process it spawned. */
  #signalGroup(signal) {
    try {
      process.kill(-this.child.pid, signal)
    } catch {
      try {
        this.child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }

  /** Relaunches against the SAME Orbit data directory — which is what
   *  "restart Orbit" means for session restore and artifact persistence. */
  async restart(options = {}) {
    await this.close()
    await new Promise((resolve) => setTimeout(resolve, 600))
    return OrbitApp.launch({ ...options, userDataDir: this.dirs.base })
  }
}

export function cleanup(app) {
  if (!app) return
  fs.rmSync(app.dirs.base, { recursive: true, force: true })
}
