import type { DockerWorkspaceProbeResult } from '@/api/services/voice-agent-api'

export type DockerWorkspaceGuidance = 'install' | 'start' | 'permission' | null

export function dockerWorkspaceGuidance(
  result: DockerWorkspaceProbeResult | null,
): DockerWorkspaceGuidance {
  if (!result || result.available) return null
  const message = (result.error || '').toLowerCase()

  if (
    result.code === 'docker_node_unavailable' ||
    message.includes('command not found') ||
    message.includes('is docker installed') ||
    message.includes('enoent')
  ) {
    return 'install'
  }
  if (
    message.includes('cannot connect to the docker daemon') ||
    message.includes('is the docker daemon running')
  ) {
    return 'start'
  }
  if (message.includes('permission denied') || message.includes('docker group')) {
    return 'permission'
  }
  return null
}
