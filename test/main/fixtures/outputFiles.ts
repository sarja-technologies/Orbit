// Minimal, genuinely well-formed files for the formats Orbit can verify, so
// tests exercise the real completeness checks rather than bypassing them.
import { deflateSync } from 'node:zlib'

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real PNG of the given size, filled with one colour. `seed` varies the
 *  colour so two files can be made to differ in content. */
export function pngBytes(width = 2, height = 2, seed = 0): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([seed & 0xff, 120, 200], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function jpegBytes(seed = 0): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jfif-body-${seed}`), Buffer.from([0xff, 0xd9])])
}

export function gifBytes(): Buffer {
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16, 1), Buffer.from([0x3b])])
}

export function webpBytes(): Buffer {
  const body = Buffer.concat([Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(12, 2)])
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length)
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body])
}

export function pdfBytes(text = 'report'): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Title (${text}) >> endobj\ntrailer << >>\n%%EOF\n`, 'latin1')
}

/** An empty but valid zip archive: just its end-of-central-directory. */
export function zipBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)])
}

/** Well-formed bytes for a filename, by extension. Anything without a
 *  verifiable format gets plain text. */
export function bytesFor(fileName: string, seed = 0): Buffer {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.png')) return pngBytes(2, 2, seed)
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return jpegBytes(seed)
  if (lower.endsWith('.gif')) return gifBytes()
  if (lower.endsWith('.webp')) return webpBytes()
  if (lower.endsWith('.pdf')) return pdfBytes(String(seed))
  if (lower.endsWith('.zip') || lower.endsWith('.docx') || lower.endsWith('.xlsx')) return zipBytes()
  return Buffer.from(`contents of ${fileName} ${seed}`)
}
