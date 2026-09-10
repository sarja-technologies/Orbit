// Who is doing the work, wherever the UI represents it.
//
// Orbit's own Saturn mark stands for Orbit — the app shell, the product.
// It is deliberately NOT what a working AI is drawn with: the model
// answering a turn has its own vendor identity, and borrowing Orbit's mark
// for it made every provider look like the same thing.
//
// The identity is resolved once, here, from the session's real model
// selection and the real catalogue, so no component has to know how to map
// a model id onto a logo.
import type { ModelOption } from '@shared/domain'
import { PROVIDERS, providerForModelId, type ProviderKey } from './providers'
import { compactModelLabel } from './modelDisplay'

export interface AgentIdentity {
  /** The mark to draw. `null` means Orbit genuinely does not know which
   *  model is answering — see `provider` below — and the neutral automatic
   *  glyph is drawn instead of a vendor logo Orbit would be guessing at. */
  provider: ProviderKey | null
  /** The name shown on the turn. The model's own short name when one is
   *  selected, otherwise the runtime's. */
  name: string
}

/** The runtime's own name, used when no specific model is selected.
 *  Antigravity picks its own default in that case and does not report which
 *  model it chose, so naming a vendor there would be a guess. */
export const RUNTIME_NAME = 'Antigravity'

/** The identity for a session whose model selection is `selectedModelId`.
 *
 *  `null` (Antigravity's own default) resolves to the runtime, not to a
 *  vendor: agy does not tell Orbit which model its default is, and
 *  inventing one would put the wrong logo on every default session.
 *
 *  A selected id whose vendor cannot be identified likewise gets no logo,
 *  but does keep its own name — the catalogue's label is a fact even when
 *  the vendor is not. */
export function agentIdentity(models: readonly ModelOption[], selectedModelId: string | null): AgentIdentity {
  if (!selectedModelId) return { provider: null, name: RUNTIME_NAME }

  const provider = providerForModelId(selectedModelId)
  const model = models.find((candidate) => candidate.id === selectedModelId) ?? null
  // A selection the catalogue no longer lists still identifies its vendor
  // from the id; the id itself then stands in for a label Orbit does not
  // have, rather than the row silently reverting to the runtime's name.
  const name = model ? compactModelLabel(model.label) : selectedModelId

  return { provider: provider === 'other' ? null : provider, name }
}

/** The vendor's own name for the identity, when it has one — used where the
 *  sentence needs a maker rather than a model ("Gemini is working"). */
export function agentVendor(identity: AgentIdentity): string | null {
  return identity.provider ? PROVIDERS[identity.provider].vendor : null
}
