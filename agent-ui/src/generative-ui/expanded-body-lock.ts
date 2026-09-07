const expandedWidgetOwners = new Set<symbol>()

/** Keep page scrolling locked until the final expanded widget is restored. */
export function setGenerativeUiExpandedBodyLock(owner: symbol, expanded: boolean): void {
  if (expanded) expandedWidgetOwners.add(owner)
  else expandedWidgetOwners.delete(owner)
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('generative-ui-node-expanded', expandedWidgetOwners.size > 0)
  }
}
