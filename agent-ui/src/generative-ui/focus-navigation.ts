export type GenerativeUiFocusDirection = 'next' | 'previous' | 'first' | 'last'

export function resolveGenerativeUiFocusIndex(
  currentIndex: number,
  itemCount: number,
  direction: GenerativeUiFocusDirection,
): number {
  if (!Number.isSafeInteger(itemCount) || itemCount <= 0) return -1
  if (direction === 'first') return 0
  if (direction === 'last') return itemCount - 1
  const current = Number.isSafeInteger(currentIndex) && currentIndex >= 0 && currentIndex < itemCount
    ? currentIndex
    : 0
  if (direction === 'next') return (current + 1) % itemCount
  return (current - 1 + itemCount) % itemCount
}
