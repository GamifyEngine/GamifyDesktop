import type { GamifyDesktopApi } from '../shared/types'

declare global {
  interface Window {
    api: GamifyDesktopApi
  }
}

export {}
