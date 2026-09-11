import type { ModelOption, OrbitPreferences } from './domain'
import { ORBIT_DEFAULT_MODEL_ID } from './defaultModel'
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from './permissionMode'

/** What a new session starts on, and why — the "why" is what the Settings
 *  panel needs in order to be honest about a saved choice that no longer
 *  exists. */
export interface ResolvedDefaultModel {
  /** The concrete id a new session is created with. Never null: every run
   *  Orbit makes names its model explicitly. */
  modelId: string
  /** 'preference' — the user's saved default, still in the catalogue.
   *  'factory'    — Orbit's own default, because nothing was saved.
   *  'fallback'   — the saved default is gone and Orbit's own was used.
   *  'unavailable'— the saved default is gone and Orbit's own is not in the
   *                 catalogue either, so nothing here can be trusted and
   *                 the user has to choose. `modelId` is still concrete so
   *                 a run never falls back to letting agy decide. */
  source: 'preference' | 'factory' | 'fallback' | 'unavailable'
  /** The saved id that could not be honoured, for the UI to name. */
  missingModelId: string | null
}

/** The model a new session should be created on.
 *
 *  An empty catalogue means Orbit could not read one — not that the models
 *  are gone — so a saved preference is taken at face value there rather
 *  than being reported as missing on the strength of no evidence.
 *
 *  Deterministic in every branch, and never resolves to "let agy choose":
 *  the explicit `--model` invariant holds even when the catalogue and the
 *  saved preference disagree. */
export function resolveDefaultModel(preferences: OrbitPreferences, catalogue: readonly ModelOption[]): ResolvedDefaultModel {
  const saved = preferences.defaultModelId?.trim() || null
  const known = (id: string): boolean => catalogue.length === 0 || catalogue.some((model) => model.id === id)

  if (!saved) {
    return { modelId: ORBIT_DEFAULT_MODEL_ID, source: known(ORBIT_DEFAULT_MODEL_ID) ? 'factory' : 'unavailable', missingModelId: null }
  }
  if (known(saved)) return { modelId: saved, source: 'preference', missingModelId: null }
  // The saved choice is genuinely absent from a catalogue Orbit could read.
  if (known(ORBIT_DEFAULT_MODEL_ID)) return { modelId: ORBIT_DEFAULT_MODEL_ID, source: 'fallback', missingModelId: saved }
  return { modelId: ORBIT_DEFAULT_MODEL_ID, source: 'unavailable', missingModelId: saved }
}

/** The permission mode a new session should be created in. Anything
 *  unrecognized falls back to asking, which is the safe direction. */
export function resolveDefaultPermissionMode(preferences: OrbitPreferences): PermissionMode {
  const saved = preferences.defaultPermissionMode
  return saved === 'ask' || saved === 'skip' ? saved : DEFAULT_PERMISSION_MODE
}
