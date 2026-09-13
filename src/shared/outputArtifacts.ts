// What counts as a generated OUTPUT, as opposed to ordinary project work.
//
// This distinction is the whole point of surfacing artifacts in the
// conversation. An agent working in a repository writes source files
// constantly — every one of those is ordinary work, and a turn that edits
// forty of them must not grow forty cards. A generated image, a PDF report,
// an exported CSV or a zip is different: it is a deliverable the user asked
// for, and the thing they will want to look at, open and find again.
//
// So the lists below are deliberately closed. They are not "anything
// binary" and not "anything with a mime type": they are formats that are
// almost never hand-edited source, plus two plain-text formats that only
// count under stronger evidence (see `evidence`).

export type OutputKind = 'image' | 'video' | 'audio' | 'document' | 'data' | 'archive' | 'text'

/** How much evidence a file needs before it is surfaced.
 *
 *  - `created-or-changed`: appearing or changing during the turn is enough.
 *    Nobody writes a PNG or a PDF as a side effect of editing code.
 *  - `created-and-named`: the file must be new this turn AND the agent's own
 *    reply must name it. A `.md` or `.txt` is as likely to be a README or a
 *    scratch note as a requested report; the reply naming it is what says
 *    it was handed to the user. The path itself never comes from the reply —
 *    only the confirmation does. */
export type OutputEvidence = 'created-or-changed' | 'created-and-named'

interface OutputFormat {
  kind: OutputKind
  mimeType: string
  evidence: OutputEvidence
  /** Rendered inline as an image preview in the conversation. */
  inlinePreview?: boolean
}

const FORMATS: Readonly<Record<string, OutputFormat>> = {
  '.png': { kind: 'image', mimeType: 'image/png', evidence: 'created-or-changed', inlinePreview: true },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg', evidence: 'created-or-changed', inlinePreview: true },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg', evidence: 'created-or-changed', inlinePreview: true },
  '.webp': { kind: 'image', mimeType: 'image/webp', evidence: 'created-or-changed', inlinePreview: true },
  '.gif': { kind: 'image', mimeType: 'image/gif', evidence: 'created-or-changed', inlinePreview: true },
  // Shown through <img>, where an SVG's scripts never run.
  '.svg': { kind: 'image', mimeType: 'image/svg+xml', evidence: 'created-or-changed', inlinePreview: true },
  '.bmp': { kind: 'image', mimeType: 'image/bmp', evidence: 'created-or-changed', inlinePreview: true },
  '.avif': { kind: 'image', mimeType: 'image/avif', evidence: 'created-or-changed', inlinePreview: true },
  '.mp4': { kind: 'video', mimeType: 'video/mp4', evidence: 'created-or-changed' },
  '.webm': { kind: 'video', mimeType: 'video/webm', evidence: 'created-or-changed' },
  '.mov': { kind: 'video', mimeType: 'video/quicktime', evidence: 'created-or-changed' },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg', evidence: 'created-or-changed' },
  '.wav': { kind: 'audio', mimeType: 'audio/wav', evidence: 'created-or-changed' },
  '.m4a': { kind: 'audio', mimeType: 'audio/mp4', evidence: 'created-or-changed' },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg', evidence: 'created-or-changed' },
  '.flac': { kind: 'audio', mimeType: 'audio/flac', evidence: 'created-or-changed' },
  '.pdf': { kind: 'document', mimeType: 'application/pdf', evidence: 'created-or-changed' },
  '.docx': { kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', evidence: 'created-or-changed' },
  '.pptx': { kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', evidence: 'created-or-changed' },
  '.xlsx': { kind: 'data', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', evidence: 'created-or-changed' },
  '.odt': { kind: 'document', mimeType: 'application/vnd.oasis.opendocument.text', evidence: 'created-or-changed' },
  '.ods': { kind: 'data', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', evidence: 'created-or-changed' },
  '.epub': { kind: 'document', mimeType: 'application/epub+zip', evidence: 'created-or-changed' },
  '.csv': { kind: 'data', mimeType: 'text/csv', evidence: 'created-or-changed' },
  '.tsv': { kind: 'data', mimeType: 'text/tab-separated-values', evidence: 'created-or-changed' },
  '.zip': { kind: 'archive', mimeType: 'application/zip', evidence: 'created-or-changed' },
  '.tar': { kind: 'archive', mimeType: 'application/x-tar', evidence: 'created-or-changed' },
  '.gz': { kind: 'archive', mimeType: 'application/gzip', evidence: 'created-or-changed' },
  '.tgz': { kind: 'archive', mimeType: 'application/gzip', evidence: 'created-or-changed' },
  '.7z': { kind: 'archive', mimeType: 'application/x-7z-compressed', evidence: 'created-or-changed' },
  '.txt': { kind: 'text', mimeType: 'text/plain', evidence: 'created-and-named' },
  '.md': { kind: 'text', mimeType: 'text/markdown', evidence: 'created-and-named' }
}

/** Directory names never worth scanning for outputs. Every one is either
 *  machine-managed or vendored: an output inside them was not handed to the
 *  user, and walking them is the difference between a scan that costs
 *  nothing and one that stalls on a large repository. Hidden directories
 *  (`.git`, `.cache`, `.venv`, `.pytest_cache`, …) are skipped as a class —
 *  see `isSkippedDirectory`. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  'venv',
  '__pycache__',
  'bower_components',
  'Pods',
  'DerivedData'
])

export function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index).toLowerCase()
}

/** A name that marks a file still being written, or an editor's own
 *  scratch copy — never a finished output, whatever its extension. */
export function isTemporaryName(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('~$') || name.endsWith('~')) return true
  const lower = name.toLowerCase()
  return ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.download', '.swp'].some((suffix) => lower.endsWith(suffix))
}

/** Repository documents an agent writes as part of ordinary code work.
 *  Seen live: a coding turn created README.md and named it in its summary,
 *  which is exactly what a requested report looks like — so these names are
 *  excluded as a class rather than left to the evidence rule. */
const PROJECT_DOCUMENT = /^(readme|changelog|contributing|license|licence|code_of_conduct|security|authors|notice|history|agents|claude|gemini|copying|todo)(\.[^.]+)?$/i

export function isProjectDocument(name: string): boolean {
  return PROJECT_DOCUMENT.test(name)
}

/** The output format a filename is, or null when it is ordinary project
 *  work. Matched on extension: the agent chose the name deliberately, and
 *  second-guessing it by sniffing bytes would be wrong more often than not. */
export function outputFormatFor(name: string): OutputFormat | null {
  if (isTemporaryName(name)) return null
  const format = FORMATS[extensionOf(name)] ?? null
  if (format?.kind === 'text' && isProjectDocument(name)) return null
  return format
}

export function outputKindFor(name: string): OutputKind | null {
  return outputFormatFor(name)?.kind ?? null
}

export function outputMimeTypeFor(name: string): string | null {
  return FORMATS[extensionOf(name)]?.mimeType ?? null
}

/** Whether the conversation shows this file as an inline image. */
export function hasInlinePreview(name: string): boolean {
  return FORMATS[extensionOf(name)]?.inlinePreview === true
}

/** Whether Orbit may hand this file to the OS to open. The same closed list:
 *  nothing executable, no scripts, no HTML — so an artifact can never be
 *  used to launch something. Anything else can still be revealed. */
export function isOpenableOutput(name: string): boolean {
  return extensionOf(name) in FORMATS && !isTemporaryName(name)
}

/** Short, human label for a file card: `PNG image`, `PDF document`. */
export function outputTypeLabel(name: string): string {
  const extension = extensionOf(name).slice(1).toUpperCase()
  const kind = outputKindFor(name)
  if (!kind) return extension ? `${extension} file` : 'File'
  const noun: Record<OutputKind, string> = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    document: 'document',
    data: 'data',
    archive: 'archive',
    text: 'text'
  }
  return `${extension} ${noun[kind]}`
}

/** Media gets a toast when it arrives for a session the user is not looking
 *  at. Kept to the two kinds that wording exists for. */
export type MediaKind = 'image' | 'video'

export function mediaKindFor(name: string): MediaKind | null {
  const kind = outputKindFor(name)
  return kind === 'image' || kind === 'video' ? kind : null
}

export function mediaAddedMessage(kind: MediaKind): string {
  return kind === 'video' ? 'Video added to Artifacts' : 'Image added to Artifacts'
}
