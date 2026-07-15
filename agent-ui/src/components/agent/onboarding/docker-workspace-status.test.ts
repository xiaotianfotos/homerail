import { describe, expect, it } from 'vitest'

import { dockerWorkspaceGuidance } from './docker-workspace-status'

describe('Docker workspace guidance', () => {
  it('does not add guidance before probing or after success', () => {
    expect(dockerWorkspaceGuidance(null)).toBeNull()
    expect(dockerWorkspaceGuidance({ available: true, host_path: '/workspace' })).toBeNull()
  })

  it('prompts installation when no Docker-capable Node can be started', () => {
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      code: 'docker_node_unavailable',
      error: 'No connected docker-capable node available',
    })).toBe('install')
  })

  it('distinguishes a stopped daemon from a permission problem', () => {
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      error: 'Cannot connect to the Docker daemon. Is Docker running?',
    })).toBe('start')
    expect(dockerWorkspaceGuidance({
      available: false,
      host_path: '/workspace',
      error: 'permission denied while trying to connect to the Docker daemon; add the user to the docker group',
    })).toBe('permission')
  })
})
