import type { OrbitApi } from '@shared/contracts'

export function getOrbitApi(): OrbitApi | null {
  return (window as Window & { orbit?: OrbitApi }).orbit ?? null
}

/** The preload API, or a thrown error naming what is missing.
 *
 *  Lives here rather than in App so any component can reach the one narrow
 *  bridge Orbit exposes, without a second accessor drifting out of step
 *  with this one. */
export function requireOrbitApi(): OrbitApi {
  const orbit = getOrbitApi()
  if (!orbit) throw new Error('The Orbit preload API is unavailable.')
  return orbit
}
