// What counts as generated MEDIA, as opposed to an ordinary project file.
//
// This distinction is the whole point of the artifact bridge. An agent
// working in a repository writes source files constantly — every one of
// those is ordinary work and belongs in Files, not in Artifacts. A
// generated image or video is different: it is an output the user asked
// for, it has no meaning as text, and it is the thing they will want to
// look at, find again and share.
//
// So the list below is deliberately closed and deliberately short. It is
// not "anything binary" and not "anything with a mime type we recognize":
// it is the media formats Orbit can genuinely preview, which is the only
// honest reason to promote a file into Artifacts.

/** Media Orbit surfaces as an artifact, by extension. Lowercase, with the
 *  leading dot, matched against the file's own name. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'] as const
const VIDEO_EXTENSIONS = ['.mp4', '.webm'] as const

export type MediaKind = 'image' | 'video'

/** Directory names never worth scanning for generated media. Every one is
 *  either machine-managed or vendored: media inside them was not produced
 *  by this turn, and walking them is the difference between a scan that
 *  costs nothing and one that stalls on a large repository. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store'
])

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index).toLowerCase()
}

/** The kind of media a filename is, or null when it is not media at all.
 *
 *  Matched on extension rather than content: the file is written by an
 *  agent on the user's own machine, and sniffing bytes to second-guess a
 *  name it chose deliberately would be more wrong more often. */
export function mediaKindFor(name: string): MediaKind | null {
  const extension = extensionOf(name)
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image'
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return 'video'
  return null
}

/** Whether this file is media Orbit should register as an artifact. A
 *  source file, a config, a lockfile, a README — all false. */
export function isMediaArtifact(name: string): boolean {
  return mediaKindFor(name) !== null
}

/** The notification wording for a registered artifact. Says what the thing
 *  is, in the user's terms, and nothing about how it was detected. */
export function mediaAddedMessage(kind: MediaKind): string {
  return kind === 'video' ? 'Video added to Artifacts' : 'Image added to Artifacts'
}
