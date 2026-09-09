import anthropicMark from '../../assets/providers/anthropic.svg?raw'
import geminiMark from '../../assets/providers/gemini.svg?raw'
import openaiMark from '../../assets/providers/openai.svg?raw'
import { PROVIDERS, type ProviderKey } from '../lib/providers'

/** The committed provider marks, keyed the same way the catalogue is
 *  bucketed. A provider absent from here has no sourced asset and falls back
 *  to its monogram — Orbit never draws a substitute logo. */
const MARKS: Partial<Record<ProviderKey, string>> = {
  gemini: geminiMark,
  anthropic: anthropicMark,
  openai: openaiMark
}

const SYMBOL_ID: Record<ProviderKey, string> = {
  gemini: 'orbit-provider-gemini',
  anthropic: 'orbit-provider-anthropic',
  openai: 'orbit-provider-openai',
  other: 'orbit-provider-other'
}

/** Each mark is turned into one <symbol> so its path data exists once in the
 *  document however many rows reference it, and so `currentColor` inside a
 *  monochrome mark resolves against the row that uses it. */
function toSymbol(key: ProviderKey, svg: string): string {
  const openTag = /<svg[^>]*>/.exec(svg)?.[0] ?? ''
  const viewBox = /viewBox="([^"]+)"/.exec(openTag)?.[1] ?? '0 0 24 24'
  // A fill declared on the root <svg> would be lost when the tag is dropped,
  // so it is carried onto the symbol instead — otherwise a mark that relies
  // on it silently renders black on a dark surface.
  const fill = /\sfill="([^"]+)"/.exec(openTag)?.[1]
  const fillAttr = fill && fill !== 'none' ? ` fill="${fill}"` : ''
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  return `<symbol id="${SYMBOL_ID[key]}" viewBox="${viewBox}"${fillAttr}>${inner}</symbol>`
}

const SPRITE = Object.entries(MARKS)
  .map(([key, svg]) => toSymbol(key as ProviderKey, svg))
  .join('')

/** Mounted once at the app root. The markup is a build-time constant read
 *  from the committed asset files — never anything user- or provider-supplied. */
export function ProviderLogoSprite(): JSX.Element {
  return <svg className="provider-sprite" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: SPRITE }} />
}

export function ProviderLogo({ provider, size = 18 }: { provider: ProviderKey; size?: number }): JSX.Element {
  const identity = PROVIDERS[provider]
  if (!MARKS[provider]) {
    return (
      <span className="provider-logo provider-logo-text" style={{ width: size, height: size }} aria-hidden="true">
        {identity.monogram}
      </span>
    )
  }
  return (
    <svg className={`provider-logo provider-logo-${provider}`} width={size} height={size} aria-hidden="true" focusable="false">
      <use href={`#${SYMBOL_ID[provider]}`} />
    </svg>
  )
}
