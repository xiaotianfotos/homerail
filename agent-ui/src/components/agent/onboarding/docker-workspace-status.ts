import type { DockerWorkspaceProbeResult } from '@/api/services/voice-agent-api'

export type DockerWorkspaceGuidance = 'install' | 'start' | 'permission' | null

export function dockerWorkspaceGuidance(
  result: DockerWorkspaceProbeResult | null,
): DockerWorkspaceGuidance {
  if (!result || result.available) return null
  const message = typeof result.error === 'string' ? result.error.toLowerCase() : ''

  if (
    result.code === 'docker_node_unavailable' ||
    message.includes('command not found') ||
    message.includes('is docker installed') ||
    message.includes('enoent')
  ) {
    return 'install'
  }
  if (
    result.code === 'docker_daemon_unavailable' ||
    message.includes('cannot connect to the docker daemon') ||
    message.includes('failed to connect to the docker api') ||
    message.includes('is the docker daemon running') ||
    message.includes('dockerdesktoplinuxengine')
  ) {
    return 'start'
  }
  if (message.includes('permission denied') || message.includes('docker group')) {
    return 'permission'
  }
  return null
}

export function readableDockerWorkspaceError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
    const nested = (error as { error?: unknown }).error
    if (nested && typeof nested === 'object') {
      const nestedMessage = (nested as { message?: unknown }).message
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) return nestedMessage
    }
    if (typeof nested === 'string' && nested.trim()) return nested
  }
  return fallback
}
