export type AsyncDisposer = () => void

export interface AsyncDisposerGate {
  start(factory: () => Promise<AsyncDisposer>): Promise<boolean>
  dispose(): void
}

/**
 * Own an asynchronously-created disposer without leaking it when its Vue view
 * unmounts (or a newer initialization wins) before the factory resolves.
 */
export function createAsyncDisposerGate(): AsyncDisposerGate {
  let disposed = false
  let generation = 0
  let current: AsyncDisposer | null = null

  return {
    async start(factory) {
      const startGeneration = ++generation
      const next = await factory()
      if (disposed || startGeneration !== generation) {
        next()
        return false
      }
      current?.()
      current = next
      return true
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      current?.()
      current = null
    },
  }
}
