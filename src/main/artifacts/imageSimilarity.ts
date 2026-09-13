// Whether two image files show the same picture, whatever their encoding.
//
// Seen live (agy 1.2.2): asked for "a PNG of a mountain in the project",
// agy's `generate_image` saves a JPEG into its own folder, and the agent
// then converts it into `mountain.png` in the workspace. Different bytes,
// different format, same picture — and without this the user is shown the
// image twice. Content hashes cannot see it; decoding can.
//
// Both images are decoded by Electron's own decoder and reduced to a tiny
// fixed grid, which erases encoding differences (JPEG artefacts, colour
// profile rounding) while keeping anything that makes two pictures
// genuinely different. Deliberately strict: a false "same" hides a real
// output, so anything uncertain answers "different".
import { nativeImage } from 'electron'

const GRID = 16
/** Mean per-channel difference, out of 255, below which two reductions are
 *  the same picture. A re-encode lands well under 4; two different
 *  generations of the same prompt land far above 20. */
const MAX_MEAN_DIFFERENCE = 8
const MAX_ASPECT_DIFFERENCE = 0.02

export type ImagesLookAlike = (a: string, b: string) => boolean

export const imagesLookAlike: ImagesLookAlike = (a, b) => {
  try {
    const left = reduce(a)
    const right = reduce(b)
    if (!left || !right) return false
    if (Math.abs(left.aspect - right.aspect) > MAX_ASPECT_DIFFERENCE) return false
    let total = 0
    let samples = 0
    // BGRA; alpha ignored.
    for (let index = 0; index < left.pixels.length && index < right.pixels.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        total += Math.abs(left.pixels[index + channel]! - right.pixels[index + channel]!)
        samples++
      }
    }
    return samples > 0 && total / samples <= MAX_MEAN_DIFFERENCE
  } catch {
    return false
  }
}

function reduce(filePath: string): { pixels: Buffer; aspect: number } | null {
  if (!nativeImage?.createFromPath) return null
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (!width || !height) return null
  const pixels = image.resize({ width: GRID, height: GRID, quality: 'good' }).toBitmap()
  return pixels.length === GRID * GRID * 4 ? { pixels, aspect: width / height } : null
}
