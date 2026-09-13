// Whether a file on disk is a finished instance of its format.
//
// A turn the user stopped, or one that failed, can leave a half-written
// file behind: a PNG whose encoder was killed mid-stream, a PDF that never
// got its trailer. Surfacing that as "the image you asked for" would be a
// false claim. For the formats where completeness is cheaply provable from
// the bytes themselves, this proves it — and says so honestly when it
// cannot, so the caller decides what an unprovable file is worth.
import fs from 'node:fs'
import { extensionOf } from '@shared/outputArtifacts'

export type Completeness = 'complete' | 'incomplete' | 'unverifiable'

const TAIL_BYTES = 64 * 1024

export function checkCompleteness(filePath: string): Completeness {
  const extension = extensionOf(filePath)
  const verifier = VERIFIERS[extension]
  if (!verifier) return 'unverifiable'
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size < 8) return 'incomplete'
    const head = readRange(filePath, 0, Math.min(64, stat.size))
    const tailStart = Math.max(0, stat.size - TAIL_BYTES)
    const tail = readRange(filePath, tailStart, stat.size - tailStart)
    return verifier(head, tail, stat.size) ? 'complete' : 'incomplete'
  } catch {
    return 'incomplete'
  }
}

type Verifier = (head: Buffer, tail: Buffer, size: number) => boolean

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// The IEND chunk: zero length, type, and its fixed CRC.
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
const ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06])

const png: Verifier = (head, tail) => head.subarray(0, 8).equals(PNG_SIGNATURE) && tail.subarray(tail.length - 12).equals(PNG_IEND)

// JPEG ends at an EOI marker. Some encoders pad after it, so allow a little
// trailing slack rather than insisting on the final two bytes.
const jpeg: Verifier = (head, tail) => head[0] === 0xff && head[1] === 0xd8 && tail.subarray(Math.max(0, tail.length - 32)).includes(Buffer.from([0xff, 0xd9]))

const gif: Verifier = (head, tail) => head.subarray(0, 4).toString('latin1') === 'GIF8' && tail[tail.length - 1] === 0x3b

// RIFF records its own total length; a truncated file is shorter than it says.
const webp: Verifier = (head, _tail, size) =>
  head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP' && head.readUInt32LE(4) + 8 <= size

const pdf: Verifier = (head, tail) => head.subarray(0, 5).toString('latin1') === '%PDF-' && tail.toString('latin1').includes('%%EOF')

// Zip and every zip-based format end with an end-of-central-directory record.
const zip: Verifier = (head, tail) => head[0] === 0x50 && head[1] === 0x4b && tail.includes(ZIP_EOCD)

const VERIFIERS: Readonly<Record<string, Verifier>> = {
  '.png': png,
  '.jpg': jpeg,
  '.jpeg': jpeg,
  '.gif': gif,
  '.webp': webp,
  '.pdf': pdf,
  '.zip': zip,
  '.docx': zip,
  '.xlsx': zip,
  '.pptx': zip,
  '.odt': zip,
  '.ods': zip,
  '.epub': zip
}

function readRange(filePath: string, start: number, length: number): Buffer {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}
