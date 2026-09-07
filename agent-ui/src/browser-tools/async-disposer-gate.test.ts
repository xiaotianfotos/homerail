import { describe, expect, it, vi } from 'vitest'
import { createAsyncDisposerGate, type AsyncDisposer } from './async-disposer-gate'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('async disposer gate', () => {
  it('immediately disposes initialization that resolves after unmount', async () => {
    const pending = deferred<AsyncDisposer>()
    const disposer = vi.fn()
    const gate = createAsyncDisposerGate()

    const started = gate.start(() => pending.promise)
    gate.dispose()
    pending.resolve(disposer)

    await expect(started).resolves.toBe(false)
    expect(disposer).toHaveBeenCalledOnce()
    gate.dispose()
    expect(disposer).toHaveBeenCalledOnce()
  })

  it('disposes an obsolete initializer without replacing the current one', async () => {
    const older = deferred<AsyncDisposer>()
    const newer = deferred<AsyncDisposer>()
    const disposeOlder = vi.fn()
    const disposeNewer = vi.fn()
    const gate = createAsyncDisposerGate()

    const olderStart = gate.start(() => older.promise)
    const newerStart = gate.start(() => newer.promise)
    newer.resolve(disposeNewer)
    await expect(newerStart).resolves.toBe(true)
    older.resolve(disposeOlder)
    await expect(olderStart).resolves.toBe(false)

    expect(disposeOlder).toHaveBeenCalledOnce()
    expect(disposeNewer).not.toHaveBeenCalled()
    gate.dispose()
    expect(disposeNewer).toHaveBeenCalledOnce()
  })
})
