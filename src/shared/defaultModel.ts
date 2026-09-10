// Orbit's own default model.
//
// Orbit — not Antigravity — decides which model a session starts on. That
// used to be the other way round: a conversation stored `model = null`,
// Orbit omitted `--model` entirely, and agy picked whatever it liked. The
// user was shown "Default model" with a generic glyph, and nothing in
// Orbit, including the transcript's own identity line, could say which
// model had actually answered.
//
// So `null` is no longer a model state Orbit has an opinion about. It is
// only ever a *legacy storage* value, and it means this id. Every layer
// resolves it through here, which is what keeps the renderer, the runtime
// and the provider agreeing about a single concrete model.
//
// The id is a real base id from the live `agy models` catalogue, whose raw
// entries are per-tier (`gemini-3.8-flash-low|medium|high`) and are grouped
// back into this base by modelCatalog.normalizeModels. Its reasoning tiers
// are therefore read from the live catalogue like any other model's — this
// file names the model, and claims nothing else about it.

/** The model a new Orbit session starts on, and what a legacy `null`
 *  selection resolves to. A base id: its reasoning tiers come from the
 *  normalized catalogue, never from here. */
export const ORBIT_DEFAULT_MODEL_ID = 'gemini-3.8-flash'

/** The concrete model id for a stored selection.
 *
 *  `null`/`undefined`/empty is legacy storage written before Orbit owned a
 *  default, and resolves to Orbit's. Anything else is the user's own
 *  explicit choice and is returned untouched — including an id the
 *  catalogue no longer lists, which stays visible as a stale selection
 *  rather than being silently rewritten to the default. */
export function resolveModelId(stored: string | null | undefined): string {
  const trimmed = stored?.trim()
  return trimmed ? trimmed : ORBIT_DEFAULT_MODEL_ID
}

/** Whether a selection is Orbit's default — including a legacy `null` that
 *  means it. Used only to *label* the default in the chooser; the id sent
 *  to agy is the real one either way. */
export function isOrbitDefaultModel(selected: string | null | undefined): boolean {
  return resolveModelId(selected) === ORBIT_DEFAULT_MODEL_ID
}
