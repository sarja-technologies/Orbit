#!/usr/bin/env node
// A stand-in for the `agy` CLI with the one property that matters for Stop:
// like real agy 1.2.2 (captured live), it runs its "commands" in a process
// group of their own, so they outlive agy unless Orbit terminates them.
//
// Structured mode (`--print <prompt>`): behaviour is chosen by the prompt.
//   DELAYED_WRITER <path> <ms>  start a detached writer, then wait forever
//   STUBBORN                    also ignore SIGTERM
//   SLOW_REPLY <ms>             reply after a delay
//   anything else               reply at once
//
// Control mode (`--control`): used by the PTY session test, which drives the
// session state machine itself and needs only a real process tree. Reads
// lines on stdin: `writer <path> <ms>` starts a detached writer, `helper`
// starts a long-lived child in agy's own group (like an MCP server).
const { spawn } = require('node:child_process')

const args = process.argv.slice(2)
const conversation = '00000000-0000-4000-8000-000000000001'
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

function startWriter(target, delayMs) {
  // Writes a real, complete PNG after the delay — exactly the file that
  // would be claimed by a later turn if this process were left running.
  const script = `
    const fs = require('node:fs'), zlib = require('node:zlib')
    const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1 } return (~c) >>> 0 }
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2
    const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(14))), chunk('IEND', Buffer.alloc(0))])
    setTimeout(() => fs.writeFileSync(${JSON.stringify(target)}, png), ${Number(delayMs)})
    setTimeout(() => {}, ${Number(delayMs)} + 60000)
  `
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

if (args[0] === '--control') {
  let buffered = ''
  process.stdin.on('data', (chunk) => {
    buffered += chunk.toString()
    let index
    while ((index = buffered.indexOf('\n')) !== -1) {
      const [command, ...rest] = buffered.slice(0, index).trim().split(' ')
      buffered = buffered.slice(index + 1)
      if (command === 'writer') process.stdout.write(`writer ${startWriter(rest[0], rest[1])}\n`)
      if (command === 'helper') {
        const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        process.stdout.write(`helper ${helper.pid}\n`)
      }
    }
  })
  setInterval(() => {}, 1000)
} else {
  const prompt = args[args.indexOf('--print') + 1] ?? ''
  emit({ event: 'init', conversation_id: conversation })
  const [mode, ...rest] = prompt.split(' ')
  if (mode === 'DELAYED_WRITER' || mode === 'STUBBORN') {
    if (mode === 'STUBBORN') process.on('SIGTERM', () => {})
    const [target, delay] = mode === 'STUBBORN' ? [rest[0], rest[1]] : [rest[0], rest[1]]
    const pid = startWriter(target, delay)
    emit({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: `writer ${pid}` } } } })
    setInterval(() => {}, 1000)
  } else {
    const delay = mode === 'SLOW_REPLY' ? Number(rest[0]) : 0
    setTimeout(() => {
      emit({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.' } })
      emit({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: 'Done.' } })
      process.exit(0)
    }, delay)
  }
}
