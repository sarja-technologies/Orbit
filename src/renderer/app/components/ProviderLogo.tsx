import anthropicMark from '../../assets/providers/anthropic.svg?raw'
import geminiMark from '../../assets/providers/gemini.svg?raw'
import openaiMark from '../../assets/providers/openai.svg?raw'
import { PROVIDERS, type ProviderKey } from '../lib/providers'
import type { AgentIdentity } from '../lib/agentIdentity'

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
    <svg
      className={`provider-logo provider-logo-${provider}`}
      width={size}
      height={size}
      role="img"
      aria-label={`${identity.label} logo`}
      focusable="false"
      data-provider={provider}
    >
      <use href={`#${SYMBOL_ID[provider]}`} />
    </svg>
  )
}

/** Marks a choice no single vendor owns: Antigravity's own default model,
 *  and a working turn whose model Orbit genuinely cannot identify.
 *  Deliberately not a provider mark, and deliberately not Orbit's Saturn —
 *  Orbit is the app, not the AI. */
export function AutoGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" data-provider="unknown">
      <circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeDasharray="2.6 2.4" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" />
    </svg>
  )
}

/** The mark for whichever AI is currently working — the single place the
 *  "logo or neutral glyph?" decision is made, so every surface that shows
 *  the active agent (chat rows, the pending reply, activity rows) agrees by
 *  construction rather than by repeating the same conditional. */
export function AgentMark({ identity, size = 15 }: { identity: AgentIdentity; size?: number }): JSX.Element {
  if (!identity.provider) return <AutoGlyph />
  return <ProviderLogo provider={identity.provider} size={size} />
}
