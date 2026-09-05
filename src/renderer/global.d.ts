import type { OrbitApi } from '@shared/contracts'

declare global {
  interface Window {
    orbit: OrbitApi
  }
}

export {}
