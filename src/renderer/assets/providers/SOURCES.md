# Provider logo assets

Every file here is the provider's own published mark, fetched once during
development and committed so the application never reaches the network to
render a logo. Nothing here is redrawn, traced or approximated by Orbit.

| File | Provider | Fetched from | Date |
| --- | --- | --- | --- |
| `gemini.svg` | Google Gemini | `https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg` (the sparkle Google serves on gemini.google.com) | 2026-09-07 |
| `anthropic.svg` | Anthropic / Claude | `https://www.anthropic.com/images/icons/safari-pinned-tab.svg` | 2026-09-07 |
| `openai.svg` | OpenAI | `https://cdn.oaistatic.com/assets/favicon-l4nq08hd.svg` | 2026-09-07 |

## Local modifications

Only the minimum needed to inline them safely; no geometry was touched.

- `gemini.svg` — the gradient's id was namespaced (`orbit-gemini-sparkle-gradient`)
  so it cannot collide with anything else in the document.
- `anthropic.svg` — potrace's XML prolog, DOCTYPE and `<metadata>` removed, and
  the hardcoded `#000000` fill replaced with `currentColor` so the mark inherits
  Orbit's text colour instead of turning invisible on a dark surface.
- `openai.svg` — the published file carries a `<style>` block with `:root`
  rules. Inlined into Orbit's document those rules would escape the symbol and
  restyle the whole page, so the block was removed and the fill moved onto the
  element as `currentColor`.

A provider with no asset here renders a text monogram instead — see
`providerLogos.tsx`. Orbit never invents a logo for a provider it cannot source
one for.
