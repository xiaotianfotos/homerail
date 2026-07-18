const GITHUB_HTTPS_RE = /\bhttps?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi
const GITHUB_SSH_RE = /\bgit@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi

function repositoryLabel(owner: string, repository: string): string {
  return `${owner}/${repository.replace(/\.git$/i, '')}`
}

/** Keep repository references readable without exposing full clone URLs. */
export function formatRepositoryReferencesForDisplay(text: string): string {
  return text
    .replace(GITHUB_HTTPS_RE, (_match, owner: string, repository: string) => (
      repositoryLabel(owner, repository)
    ))
    .replace(GITHUB_SSH_RE, (_match, owner: string, repository: string) => (
      repositoryLabel(owner, repository)
    ))
}

/** Apply display-only repository formatting throughout a plain API payload. */
export function formatRepositoryPayloadForDisplay<T>(value: T): T {
  if (typeof value === 'string') {
    return formatRepositoryReferencesForDisplay(value) as T
  }
  if (Array.isArray(value)) {
    return value.map(item => formatRepositoryPayloadForDisplay(item)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, formatRepositoryPayloadForDisplay(item)]),
    ) as T
  }
  return value
}
