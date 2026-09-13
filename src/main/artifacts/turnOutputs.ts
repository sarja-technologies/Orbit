// Decides which files a finished turn actually handed to the user.
//
// The inputs are already facts — files that appeared or changed in the
// workspace during the turn, and files the provider's own tools generated
// elsewhere. This is the policy that turns those facts into cards, kept
// pure so every rule is pinned by a test rather than by a live agent:
//
//   1. Only deliverable formats. Source code never becomes a card.
//   2. `.md` / `.txt` need more: new this turn, on a completed turn, and
//      named in the agent's own reply. The path still comes from the
//      filesystem; the reply only confirms the file was meant for the user.
//   3. A file whose format can prove its own completeness must prove it. A
//      turn that did not complete — stopped or failed — keeps only files
//      that are provably finished, so a half-written render is never
//      presented as the result.
//   4. Once per file: deduplicated by real path, and by content, preferring
//      the copy in the workspace (where the user asked for it) over the
//      provider's original. A provider image the agent converted into the
//      project (same picture, different bytes) is also collapsed onto the
//      project copy. A provider file already registered by an earlier turn
//      is not registered again.
import fs from 'node:fs'
import path from 'node:path'
import { hashFile } from '@main/files/fileStorage'
import { outputFormatFor } from '@shared/outputArtifacts'
import { checkCompleteness, type Completeness } from './fileIntegrity'

export type TurnEnding = 'completed' | 'failed' | 'cancelled'

export interface TurnOutputCandidate {
  filePath: string
  /** The folder the file must remain inside. */
  root: string
  displayName: string
  byteSize: number
  modifiedMs: number
  origin: 'workspace' | 'provider-generated'
  /** New this turn, rather than an existing file the turn changed. Provider
   *  outputs are always new. */
  created: boolean
}

export interface SelectedTurnOutput extends TurnOutputCandidate {
  contentHash: string
}

export interface SelectTurnOutputsInput {
  candidates: TurnOutputCandidate[]
  ending: TurnEnding
  /** The assistant's final reply; empty for a turn that did not complete. */
  finalText: string
  /** Provider outputs earlier turns of this conversation already registered. */
  alreadyRegistered: ReadonlyArray<{ originalPath: string; contentHash: string }>
  /** Injectable for tests. */
  completeness?: (filePath: string) => Completeness
  hash?: (filePath: string) => string
  /** Whether two image files show the same picture. Omitted means content
   *  hashes are the only notion of "the same". */
  imagesLookAlike?: (a: string, b: string) => boolean
}

export function selectTurnOutputs(input: SelectTurnOutputsInput): SelectedTurnOutput[] {
  const completeness = input.completeness ?? checkCompleteness
  const hash = input.hash ?? hashFile
  const registered = new Set(input.alreadyRegistered.map((entry) => `${entry.originalPath}\0${entry.contentHash}`))

  const byPath = new Map<string, SelectedTurnOutput>()
  const ordered = [...input.candidates].sort((a, b) => a.modifiedMs - b.modifiedMs)
  for (const candidate of ordered) {
    const fileName = path.basename(candidate.filePath)
    const format = outputFormatFor(fileName)
    if (!format) continue

    if (format.evidence === 'created-and-named') {
      if (input.ending !== 'completed' || !candidate.created || !mentions(input.finalText, fileName)) continue
    }

    const state = completeness(candidate.filePath)
    if (state === 'incomplete') continue
    if (input.ending !== 'completed' && state !== 'complete') continue

    let real: string
    let contentHash: string
    try {
      real = fs.realpathSync.native(candidate.filePath)
      contentHash = hash(real)
    } catch {
      continue // Gone since it was found.
    }
    if (candidate.origin === 'provider-generated' && registered.has(`${real}\0${contentHash}`)) continue
    if (byPath.has(real)) continue
    byPath.set(real, { ...candidate, filePath: real, contentHash })
  }

  // Same bytes in two places — typically an image the provider generated
  // and the agent then copied into the project. One card, pointing at the
  // project's copy.
  const byHash = new Map<string, SelectedTurnOutput>()
  for (const output of byPath.values()) {
    const existing = byHash.get(output.contentHash)
    if (!existing || (existing.origin !== 'workspace' && output.origin === 'workspace')) byHash.set(output.contentHash, output)
  }
  const kept = new Set(byHash.values())

  // A provider-generated image the agent then re-encoded into the project —
  // the live case is agy's JPEG saved as the PNG the user asked for. Only
  // provider images are ever dropped this way, and only in favour of an
  // image in the workspace from the same turn.
  if (input.imagesLookAlike) {
    const workspaceImages = [...kept].filter((output) => output.origin === 'workspace' && outputFormatFor(path.basename(output.filePath))?.kind === 'image')
    for (const output of [...kept]) {
      if (output.origin !== 'provider-generated' || outputFormatFor(path.basename(output.filePath))?.kind !== 'image') continue
      if (workspaceImages.some((image) => input.imagesLookAlike!(output.filePath, image.filePath))) kept.delete(output)
    }
  }
  return [...byPath.values()].filter((output) => kept.has(output))
}

/** Whether `text` names `fileName` as a whole name — `report.md` in
 *  "see report.md" or "[report](./out/report.md)", but not in
 *  "old-report.md". Case-insensitive, because models capitalize freely. */
export function mentions(text: string, fileName: string): boolean {
  if (!text || !fileName) return false
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'iu').test(text)
}
