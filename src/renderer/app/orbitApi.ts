import type { OrbitApi } from '@shared/contracts'

export function getOrbitApi(): OrbitApi | null {
  return (window as Window & { orbit?: OrbitApi }).orbit ?? null
}
